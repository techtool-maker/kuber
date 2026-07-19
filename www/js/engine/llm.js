/**
 * Layer 2 of the hybrid pipeline — LLM fallback.
 *
 * Only ever called for messages the deterministic parser could not resolve
 * confidently. That keeps cost and data exposure proportional to actual need:
 * on a normal SMS corpus this fires on roughly one message in ten.
 *
 * Design notes:
 *  - Messages are batched (default 20) so one request resolves many unknowns.
 *  - Results are cached by merchant string, so a merchant is only ever paid for
 *    once. The cache is what makes the system get cheaper the longer you use it.
 *  - Redaction strips account numbers, card digits, refs and VPAs before any
 *    text leaves the device. The model only needs the merchant and context
 *    words to categorise; it has no need for identifiers.
 *  - Failure is always soft: if the call fails, the rule-based answer stands.
 */

import { CATEGORIES } from './categorizer.js';

const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    model: 'gemini-2.0-flash',
    url: (key, model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    headers: () => ({ 'Content-Type': 'application/json' }),
    body: (prompt) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
    extract: (json) => json?.candidates?.[0]?.content?.parts?.[0]?.text || '',
  },
  anthropic: {
    label: 'Claude',
    model: 'claude-haiku-4-5-20251001',
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: (prompt, model) => ({
      model,
      max_tokens: 2048,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
    extract: (json) => json?.content?.[0]?.text || '',
  },
};

export const PROVIDER_LIST = Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, model: p.model }));

/**
 * Remove identifiers before sending text off-device.
 * Categorisation needs the merchant and the context words, nothing else.
 */
export function redact(text) {
  return String(text || '')
    .replace(/\b(?:a\/?c|acct?|account|card)\s*(?:no\.?|number|ending)?\s*[:.]?\s*[xX*]*\d{3,6}\b/gi, 'ACCOUNT')
    .replace(/\b(?:upi\s*)?(?:ref(?:erence)?|rrn|txn|utr)\s*(?:no\.?|id|#)?\s*[:.]?\s*[a-z0-9]{6,22}\b/gi, 'REF')
    .replace(/\b[a-z0-9][a-z0-9._-]{1,}@[a-z][a-z0-9]{1,}\b/gi, (m) => {
      // Keep the handle prefix — that is often the merchant identity itself.
      const prefix = m.split('@')[0];
      return /^\d{6,}$/.test(prefix) ? 'PERSON' : prefix;
    })
    .replace(/\b\d{10}\b/g, 'PHONE')
    .replace(/\b\d{12,}\b/g, 'NUMBER');
}

const SYSTEM_PROMPT = `You classify Indian bank/UPI transaction SMS messages.

For each numbered message, return the merchant's real-world brand name and one category.

Categories (use EXACTLY one of these strings):
${CATEGORIES.join(', ')}

Rules:
- "merchant" must be the recognisable brand or counterparty name (e.g. "Swiggy", "Indian Oil", "Reliance Fresh"). If the counterparty is an individual person, use "Personal Transfer".
- Money moving between the user's own accounts, or to/from wallets, is "Transfer".
- ATM cash is "Cash Withdrawal". Mutual fund/SIP/stock purchases are "Investment".
- If you genuinely cannot tell, use merchant "Unknown" and category "Miscellaneous".
- "confidence" is 0.0-1.0 reflecting how sure you are.

Respond with ONLY a JSON array, no prose:
[{"id": 1, "merchant": "Swiggy", "category": "Food Delivery", "confidence": 0.95}]`;

/** Read the saved LLM configuration. Returns null when not configured. */
export function getConfig() {
  try {
    const raw = localStorage.getItem('kuber.llm');
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    return cfg?.apiKey && cfg?.provider ? cfg : null;
  } catch {
    return null;
  }
}

export function setConfig(cfg) {
  if (!cfg) localStorage.removeItem('kuber.llm');
  else localStorage.setItem('kuber.llm', JSON.stringify(cfg));
}

// Merchant → {merchant, category} cache, so each merchant costs at most one call.
const CACHE_KEY = 'kuber.llmcache';

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function saveCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* quota — cache is optional */ }
}

export function cacheStats() {
  const cache = loadCache();
  return { entries: Object.keys(cache).length };
}

export function clearCache() {
  localStorage.removeItem(CACHE_KEY);
}

/**
 * Resolve merchant + category for transactions the rules could not handle.
 *
 * @param {Array} txns  transactions needing enrichment
 * @param {object} opts { onProgress, batchSize, signal }
 * @returns {Promise<{updated: number, cached: number, calls: number, error?: string}>}
 */
export async function enrich(txns, opts = {}) {
  const cfg = getConfig();
  if (!cfg) return { updated: 0, cached: 0, calls: 0, error: 'not-configured' };
  if (!txns.length) return { updated: 0, cached: 0, calls: 0 };

  const provider = PROVIDERS[cfg.provider];
  if (!provider) return { updated: 0, cached: 0, calls: 0, error: 'unknown-provider' };

  const cache = loadCache();
  const batchSize = opts.batchSize || 20;
  let updated = 0;
  let cachedHits = 0;
  let calls = 0;

  // Serve from cache first.
  const pending = [];
  for (const txn of txns) {
    const key = (txn.merchantRaw || txn.merchant || '').toUpperCase().trim();
    if (key && cache[key]) {
      applyResult(txn, cache[key]);
      cachedHits++;
      updated++;
    } else {
      pending.push(txn);
    }
  }

  for (let i = 0; i < pending.length; i += batchSize) {
    if (opts.signal?.aborted) break;
    const batch = pending.slice(i, i + batchSize);

    const numbered = batch
      .map((t, idx) => `${idx + 1}. ${redact(t.raw).slice(0, 300)}`)
      .join('\n');
    const prompt = `${SYSTEM_PROMPT}\n\nMessages:\n${numbered}`;

    try {
      const model = cfg.model || provider.model;
      const res = await fetch(provider.url(cfg.apiKey, model), {
        method: 'POST',
        headers: provider.headers(cfg.apiKey),
        body: JSON.stringify(provider.body(prompt, model)),
        signal: opts.signal,
      });
      calls++;

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { updated, cached: cachedHits, calls, error: `HTTP ${res.status}: ${detail.slice(0, 200)}` };
      }

      const json = await res.json();
      const text = provider.extract(json);
      const results = parseJsonArray(text);

      for (const r of results) {
        const txn = batch[(r.id || 0) - 1];
        if (!txn || !r.category) continue;
        if (!CATEGORIES.includes(r.category)) continue;
        applyResult(txn, r);
        updated++;
        const key = (txn.merchantRaw || txn.merchant || '').toUpperCase().trim();
        if (key) cache[key] = { merchant: r.merchant, category: r.category, confidence: r.confidence };
      }

      opts.onProgress?.({ done: Math.min(i + batchSize, pending.length), total: pending.length });
    } catch (err) {
      if (err.name === 'AbortError') break;
      return { updated, cached: cachedHits, calls, error: err.message };
    }
  }

  saveCache(cache);
  return { updated, cached: cachedHits, calls };
}

function applyResult(txn, result) {
  if (result.merchant && result.merchant !== 'Unknown') txn.merchant = result.merchant;
  if (result.category) txn.category = result.category;
  txn.categorySource = 'llm';
  txn.confidence = Math.max(txn.confidence || 0, Math.min(0.9, result.confidence || 0.75));
  txn.needsReview = false;
}

/** Models sometimes wrap JSON in prose or fences despite instructions. */
function parseJsonArray(text) {
  if (!text) return [];
  try { const d = JSON.parse(text); return Array.isArray(d) ? d : d.results || []; } catch { /* fall through */ }
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* give up */ }
  }
  return [];
}

/**
 * Free-form question answering over a pre-computed financial summary.
 * The summary is aggregate figures only — no raw SMS, no identifiers.
 */
export async function ask(question, summary, opts = {}) {
  const cfg = getConfig();
  if (!cfg) return { error: 'not-configured' };
  const provider = PROVIDERS[cfg.provider];
  if (!provider) return { error: 'unknown-provider' };

  const prompt = `You are a concise personal finance assistant for an Indian user. All amounts are in INR (₹).

Here is the user's financial summary:
${JSON.stringify(summary, null, 1)}

Question: ${question}

Answer in 2-4 sentences using specific numbers from the summary. Format amounts as ₹1,23,456 (Indian grouping). If the summary does not contain enough information to answer, say so plainly rather than guessing.`;

  try {
    const model = cfg.model || provider.model;
    const body = provider.body(prompt, model);
    if (cfg.provider === 'gemini') delete body.generationConfig.responseMimeType;

    const res = await fetch(provider.url(cfg.apiKey, model), {
      method: 'POST',
      headers: provider.headers(cfg.apiKey),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    return { text: provider.extract(json).trim() };
  } catch (err) {
    return { error: err.message };
  }
}
