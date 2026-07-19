/**
 * SMS transaction parsing engine.
 *
 * Layer 1 of the hybrid pipeline: deterministic, offline, free. Runs a bank of
 * field extractors over the raw SMS body and emits a structured transaction
 * with a confidence score. Anything scoring below REVIEW_THRESHOLD is handed to
 * the LLM fallback (see engine/llm.js) or queued for user review.
 *
 * Deliberately has no dependency on the DOM or on storage so it can be lifted
 * into the Flutter/Dart port later with only syntax changes.
 */

import { lookupMerchant, lookupBank, UPI_HANDLES, EMAIL_TLDS, normalise } from '../data/merchants.js';

export const REVIEW_THRESHOLD = 0.62;

// --- Intent classification --------------------------------------------------

const DEBIT_VERBS = /\b(debited|debit|spent|paid|sent|withdrawn|withdrawal|deducted|purchase[d]?|transferred|txn of|charged|payment of)\b/i;
const CREDIT_VERBS = /\b(credited|credit|received|deposited|refund(?:ed)?|reversal|reversed|cashback|has been added)\b/i;

/** Messages that look financial but must never become a transaction. */
const HARD_REJECT = [
  /\b(otp|one[- ]time password|verification code|do not share|never share)\b/i,
  /\b(is requesting|has requested|collect request|requesting money|payment request)\b/i,
  /\b(will be debited|will be deducted|is due|due on|reminder|kindly pay|please pay|scheduled for)\b/i,
  /\b(failed|declined|unsuccessful|could not be processed|rejected)\b/i,
  /\b(pre[- ]?approved|eligible for|apply now|click here|offer|congratulations|limited period|hurry)\b/i,
  /\b(balance in your|available balance is|your balance as on|statement is ready|e[- ]?statement)\b/i,
];

/** Marks the message as a real event, but one we surface rather than count. */
const SOFT_FLAGS = [
  { re: /\b(failed|declined|unsuccessful|reversed|reversal)\b/i, flag: 'failed' },
  { re: /\b(refund(?:ed)?|returned to your)\b/i, flag: 'refund' },
  { re: /\bsalary\b/i, flag: 'salary' },
  { re: /\b(emi|equated monthly)\b/i, flag: 'emi' },
  { re: /\b(sip|systematic investment)\b/i, flag: 'sip' },
  { re: /\b(auto[- ]?debit|mandate|nach|standing instruction|si executed)\b/i, flag: 'autodebit' },
];

// --- Field extractors -------------------------------------------------------

const BALANCE_RE = /\b(?:avl(?:bl)?\.?\s*bal(?:ance)?|available\s*bal(?:ance)?|a\/?c\s*bal(?:ance)?|clr\s*bal|closing\s*bal(?:ance)?|bal)\b\s*(?:is|:|-)?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i;
const LIMIT_RE = /\b(?:avl(?:bl)?\.?\s*lmt|available\s*limit|avl\s*limit|credit\s*limit)\b\s*(?:is|:|-)?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i;
const AMOUNT_CURRENCY_RE = /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i;
const AMOUNT_BARE_RE = /\b(?:debited|credited|spent|sent|paid|withdrawn)\s*(?:by|for|of)?\s*([\d,]+\.\d{1,2})\b/i;
const ACCOUNT_RE = /\b(?:a\/?c|acct?|account)\s*(?:no\.?|number|ending)?\s*[:.]?\s*(?:x+|\*+|X+)?\s*(\d{3,6})\b/i;
const CARD_RE = /\b(?:card|cc|credit\s*card|debit\s*card)\s*(?:no\.?|number|ending)?\s*[:.]?\s*(?:x+|\*+|X+)?\s*(\d{3,6})\b/i;
const VPA_RE = /\b([a-z0-9][a-z0-9._-]{1,})@([a-z][a-z0-9]{1,})\b/i;
const REF_RE = /\b(?:upi\s*)?(?:ref(?:erence)?|rrn|txn|transaction|utr)\s*(?:no\.?|id|#)?\s*[:.]?\s*([a-z0-9]{6,22})\b/i;

/** Strip grouping commas and parse to a number. */
function toAmount(text) {
  if (!text) return null;
  const n = parseFloat(String(text).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Indian bank SMS use at least six date shapes. Try each, widest first.
 * Returns epoch ms, or null when no date is present (caller falls back to the
 * SMS receive timestamp, which is more reliable anyway).
 */
export function extractDate(body, fallback = null) {
  const text = String(body || '');

  // 12-Jul-2025 / 12Jul25 / 12 Jul 25
  let m = text.match(/\b(\d{1,2})[-\s]?([a-z]{3})[a-z]*[-\s,]?(\d{2,4})\b/i);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    const year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    const d = new Date(year, MONTHS[m[2].toLowerCase()], parseInt(m[1], 10));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }

  // 12/07/25, 12-07-2025 (day-first: Indian convention)
  m = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    const d = new Date(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }

  // 2025-07-12 (ISO)
  m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }

  return fallback;
}

/**
 * Merchant extraction, ordered most-specific first. Each pattern captures the
 * fragment that a given bank's template puts the counterparty in.
 */
const MERCHANT_PATTERNS = [
  // ICICI: "; SWIGGY credited" / "; JOHN DOE credited"
  { re: /;\s*([A-Za-z0-9][A-Za-z0-9 .&'*_-]{2,45}?)\s+credited/i, weight: 0.9 },
  // "trf to SWIGGY Refno" (SBI)
  { re: /\btrf\s+to\s+([A-Za-z0-9][A-Za-z0-9 .&'*_-]{2,45}?)(?=\s+(?:ref|on|\d)|[.;]|$)/i, weight: 0.9 },
  // "to VPA merchant@ybl"
  { re: /\bto\s+vpa\s+([a-z0-9][a-z0-9._-]+@[a-z][a-z0-9]+)/i, weight: 0.95, isVpa: true },
  // "at AMAZON on 12-07-25" / "at DMART ."
  { re: /\bat\s+([A-Za-z0-9][A-Za-z0-9 .&'*_-]{2,45}?)(?=\s+(?:on|dated|avl|ref|towards)\b|[.;]|$)/i, weight: 0.85 },
  // "To SWIGGY On" (HDFC)
  { re: /\bto\s+([A-Za-z0-9][A-Za-z0-9 .&'*_-]{2,45}?)(?=\s+(?:on|dated|avl|ref|upi|towards)\b|[.;]|$)/i, weight: 0.8 },
  // "Info: NEFT-SALARY-ACME" / "Info:UPI/SWIGGY"
  { re: /\binfo\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 .&'*/_-]{2,45}?)(?=[.;]|$)/i, weight: 0.7 },
  // "towards NETFLIX"
  { re: /\btowards\s+([A-Za-z0-9][A-Za-z0-9 .&'*_-]{2,45}?)(?=\s+(?:on|ref)\b|[.;]|$)/i, weight: 0.8 },
  // "by ACME PAYROLL" for credits
  { re: /\bby\s+([A-Za-z][A-Za-z0-9 .&'*_-]{3,45}?)(?=\s+(?:on|ref)\b|[.;]|$)/i, weight: 0.6 },
];

/** Junk that leaks into merchant captures from template boilerplate. */
const MERCHANT_NOISE = /\b(upi|imps|neft|rtgs|ach|nach|pos|atm|txn|transaction|ref(?:no)?|no|acct?|a\/c|bank|ltd|limited|pvt|private|india|in|payment|paytm qr|qr|via|from|the)\b/gi;

/** Turn a captured fragment into a display-worthy merchant name. */
export function cleanMerchant(raw, { isVpa = false } = {}) {
  if (!raw) return null;
  let text = String(raw).trim();

  if (isVpa || text.includes('@')) {
    const handle = text.split('@')[0];
    // Numeric-only VPAs are phone numbers — a person, not a merchant.
    if (/^\d{6,}$/.test(handle)) return null;
    text = handle.replace(/[._-]+/g, ' ');
  }

  text = text
    .replace(/\d{6,}/g, ' ')          // long digit runs are refs, not names
    .replace(MERCHANT_NOISE, ' ')
    .replace(/[^A-Za-z0-9 &'.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 3) return null;
  if (/^\d+$/.test(text)) return null;

  // Title-case unless it is a short acronym like KFC or LIC.
  return text
    .split(' ')
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/** Infer the payment rail. */
function detectMode(body, { vpa, cardLast4, refId }) {
  const t = body.toLowerCase();
  if (/\batm\b|cash\s*w(?:ithdraw|dl)/.test(t)) return 'atm';
  if (/\bemi\b|equated monthly/.test(t)) return 'emi';
  if (/\b(auto[- ]?debit|mandate|nach|standing instruction|si executed)\b/.test(t)) return 'autodebit';
  if (vpa || /\bupi\b|\bvpa\b/.test(t)) return 'upi';
  // HDFC's "Sent Rs.X From A/C y To Z" template is UPI but never says so.
  // A 12-digit reference is a UPI RRN, which corroborates it.
  if (/\bsent\b[\s\S]*\bfrom\b[\s\S]*\bto\b/.test(t)) return 'upi';
  if (refId && /^\d{12}$/.test(refId)) return 'upi';
  if (cardLast4 || /\b(card|pos|swipe)\b/.test(t)) return 'card';
  if (/\bimps\b/.test(t)) return 'imps';
  if (/\bneft\b/.test(t)) return 'neft';
  if (/\brtgs\b/.test(t)) return 'rtgs';
  if (/\bwallet\b/.test(t)) return 'wallet';
  if (/\bnet\s*banking\b/.test(t)) return 'netbanking';
  return 'other';
}

/**
 * Parse a single SMS into a structured transaction.
 *
 * @param {object} sms - { body, sender, ts }
 * @returns {object} result - { ok, reason?, txn?, confidence, needsReview }
 */
export function parseSms(sms) {
  const body = String(sms?.body || '').trim();
  const sender = sms?.sender || '';
  const receivedAt = sms?.ts || Date.now();

  if (body.length < 15) {
    return { ok: false, reason: 'too-short', confidence: 0 };
  }

  // --- Gate: is this a completed transaction at all? ---
  const isDebit = DEBIT_VERBS.test(body);
  const isCredit = CREDIT_VERBS.test(body);
  if (!isDebit && !isCredit) {
    return { ok: false, reason: 'no-transaction-verb', confidence: 0 };
  }

  const flags = {};
  for (const { re, flag } of SOFT_FLAGS) {
    if (re.test(body)) flags[flag] = true;
  }

  for (const re of HARD_REJECT) {
    if (re.test(body)) {
      // A refund genuinely reads as "refunded", and salary credits often carry
      // the word "credited ... balance" — don't let those trip the reject list.
      if (flags.refund || flags.salary) continue;
      return { ok: false, reason: 'rejected:' + re.source.slice(0, 28), confidence: 0, flags };
    }
  }

  // --- Amount, with balance/limit masked out so they can't be mistaken for it ---
  let scratch = body;
  const balanceMatch = body.match(BALANCE_RE);
  const limitMatch = body.match(LIMIT_RE);
  if (balanceMatch) scratch = scratch.replace(balanceMatch[0], ' ');
  if (limitMatch) scratch = scratch.replace(limitMatch[0], ' ');

  const amount = toAmount((scratch.match(AMOUNT_CURRENCY_RE) || [])[1])
              ?? toAmount((scratch.match(AMOUNT_BARE_RE) || [])[1]);

  if (!amount) {
    return { ok: false, reason: 'no-amount', confidence: 0, flags };
  }

  const balance = toAmount(balanceMatch?.[1]);
  const creditLimit = toAmount(limitMatch?.[1]);

  // --- Identity fields ---
  const cardLast4 = (body.match(CARD_RE) || [])[1] || null;
  const accountLast4 = (body.match(ACCOUNT_RE) || [])[1] || null;

  let vpa = null;
  const vpaMatch = body.match(VPA_RE);
  if (vpaMatch && !EMAIL_TLDS.has(vpaMatch[2].toLowerCase())) {
    // "support@hdfcbank.com" matches as far as "@hdfcbank", so the TLD set
    // alone is not enough — reject anything followed by a dotted suffix.
    const after = body.slice(vpaMatch.index + vpaMatch[0].length);
    if (!/^\.[a-z]{2,}/i.test(after)) vpa = vpaMatch[0].toLowerCase();
  }

  const refId = (body.match(REF_RE) || [])[1] || null;
  const ts = extractDate(body, receivedAt);
  const mode = detectMode(body, { vpa, cardLast4, refId });

  // --- Merchant ---
  let merchantRaw = null;
  let merchantWeight = 0;
  for (const pattern of MERCHANT_PATTERNS) {
    const m = body.match(pattern.re);
    if (m) {
      const cleaned = cleanMerchant(m[1], { isVpa: pattern.isVpa });
      if (cleaned) { merchantRaw = cleaned; merchantWeight = pattern.weight; break; }
    }
  }
  // Last resort: derive from the VPA handle.
  if (!merchantRaw && vpa) {
    merchantRaw = cleanMerchant(vpa, { isVpa: true });
    merchantWeight = 0.5;
  }

  // Dictionary lookup runs against the full body too, so "NETFLIX" mentioned
  // anywhere still resolves even when the template shape is unfamiliar. Body
  // matching uses a length floor so short names cannot fire on stray words.
  const known = lookupMerchant(merchantRaw) || lookupMerchant(body, { minLen: 4 });

  // An ATM withdrawal has no counterparty by definition — naming it "Unknown"
  // would send a perfectly understood transaction to the review queue.
  let merchant = known?.name || merchantRaw;
  if (!merchant && mode === 'atm') merchant = 'ATM Withdrawal';
  if (!merchant) merchant = 'Unknown';

  // --- Bank attribution ---
  const bank = lookupBank(sender)
    || (vpa ? UPI_HANDLES[vpa.split('@')[1]] : null)
    || lookupBank(body)
    || null;

  // --- Confidence: start high, subtract for every field we had to guess ---
  let confidence = 0.5;
  if (amount) confidence += 0.18;
  if (known) confidence += 0.16;
  else if (merchantRaw) confidence += merchantWeight * 0.12;
  if (accountLast4 || cardLast4) confidence += 0.08;
  if (refId) confidence += 0.05;
  if (bank) confidence += 0.05;
  if (balance !== null) confidence += 0.04;
  // A missing counterparty is only a problem when one was expected — an ATM
  // withdrawal is fully understood without it.
  if (!merchantRaw && mode !== 'atm') confidence -= 0.22;
  if (mode === 'atm') confidence += 0.12;
  if (isDebit && isCredit) confidence -= 0.10; // ambiguous template
  confidence = Math.max(0, Math.min(1, confidence));

  const direction = flags.refund ? 'credit' : (isDebit && !isCredit ? 'debit' : isCredit && !isDebit ? 'credit' : (/\bdebited\b/i.test(body) ? 'debit' : 'credit'));

  // Carried on the transaction itself, not just the wrapper: store.ingest
  // reads `txn.needsReview`, so leaving it off the txn silently discarded
  // every low-confidence parse flag.
  const needsReview = confidence < REVIEW_THRESHOLD || merchant === 'Unknown';

  return {
    ok: true,
    confidence,
    needsReview,
    txn: {
      needsReview,
      raw: body,
      source: 'sms',
      sender,
      receivedAt,
      ts,
      amount,
      direction,
      merchantRaw,
      merchant,
      suggestedCategory: known?.category || null,
      knownRecurring: !!known?.recurring,
      bank,
      accountLast4,
      cardLast4,
      creditLimit,
      vpa,
      refId,
      balance,
      mode,
      flags,
      confidence,
    },
  };
}

/** Parse many messages, returning both the hits and a rejection tally. */
export function parseBatch(messages) {
  const parsed = [];
  const rejected = [];
  const reasons = {};

  for (const sms of messages) {
    const result = parseSms(sms);
    if (result.ok) {
      parsed.push(result.txn);
    } else {
      rejected.push({ sms, reason: result.reason });
      reasons[result.reason] = (reasons[result.reason] || 0) + 1;
    }
  }
  return { parsed, rejected, reasons };
}

/**
 * Split a blob of pasted text into individual messages.
 * Supports "SENDER: body" lines, blank-line separated blocks, and one-per-line.
 */
export function splitPastedSms(text) {
  const blocks = String(text || '')
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const source = blocks.length > 1 ? blocks : String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);

  return source.map((block) => {
    const m = block.match(/^([A-Z]{2}-[A-Z0-9-]{3,}|[A-Z]{5,10})\s*[:|]\s*(.+)$/s);
    return m ? { sender: m[1], body: m[2].trim(), ts: Date.now() } : { sender: '', body: block, ts: Date.now() };
  });
}

export { normalise };
