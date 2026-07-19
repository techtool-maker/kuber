/**
 * Persistence + the single pipeline that turns raw messages into app state.
 *
 * Storage is localStorage-backed JSON. That is the right call at this scale:
 * a two-month personal corpus is a few thousand rows (~1-2 MB) and the
 * synchronous API keeps the rest of the code simple. The interface here is
 * deliberately narrow (load/save/ingest/derive) so swapping in IndexedDB or
 * SQLite (Flutter port) touches only this file.
 */

import { parseSms, parseBatch, splitPastedSms } from '../engine/parser.js';
import { categorise, shouldAskLlm } from '../engine/categorizer.js';
import {
  markDuplicates, detectRecurring, upcomingPayments, forecastMonth,
  detectAnomalies, suggestBudgets, healthScore, generateInsights,
  monthlyTotals, categoryTotals, dailyTotals, isSpend, sum, startOfMonth,
} from '../engine/intelligence.js';

const KEY = 'kuber.data.v1';
const SCHEMA_VERSION = 1;

/** Shape of a fresh, empty database. */
function emptyDb() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: { name: '', currency: 'INR', monthStartDay: 1, onboarded: false },
    txns: [],
    learning: { overrides: {}, rules: [] },
    budgets: {},
    goals: [],
    accounts: [],
    dismissedInsights: [],
    settings: { theme: 'auto', llmEnabled: false, redactBeforeSend: true, dismissedIosTip: false },
    meta: { lastImport: null, importCount: 0, lastBackup: null },
  };
}

let db = emptyDb();
const listeners = new Set();

// --- Persistence ------------------------------------------------------------

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      db = { ...emptyDb(), ...parsed };
      // Nested defaults, in case an older payload predates a field.
      db.profile = { ...emptyDb().profile, ...(parsed.profile || {}) };
      db.settings = { ...emptyDb().settings, ...(parsed.settings || {}) };
      db.learning = { ...emptyDb().learning, ...(parsed.learning || {}) };
      db.meta = { ...emptyDb().meta, ...(parsed.meta || {}) };
    }
  } catch (err) {
    console.error('Could not read saved data; starting fresh.', err);
    db = emptyDb();
  }
  return db;
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (err) {
    // Quota exceeded is the realistic failure here — surface it, don't swallow.
    console.error('Save failed', err);
    return { ok: false, error: err.name === 'QuotaExceededError'
      ? 'Storage full. Export a backup, then archive older transactions.'
      : err.message };
  }
  return { ok: true };
}

export function getDb() { return db; }

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { for (const fn of listeners) fn(db); }

export function commit() { const r = save(); emit(); return r; }

export function reset() {
  db = emptyDb();
  localStorage.removeItem(KEY);
  emit();
}

// --- Ingestion --------------------------------------------------------------

let idCounter = 0;
function nextId() {
  return `t${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Stable fingerprint used to reject re-imports of the same message.
 * Deliberately built from the raw body + timestamp rather than the parsed
 * fields, so a parser improvement never causes an accidental re-insert.
 */
function fingerprint(txn) {
  const body = (txn.raw || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `${txn.receivedAt || txn.ts}|${body}`;
}

/**
 * Run raw messages through the full pipeline and merge them into the database.
 *
 * @param {Array} messages  [{ body, sender, ts }]
 * @returns {{added, skipped, rejected, reasons, needsReview}}
 */
export function ingest(messages) {
  const { parsed, rejected, reasons } = parseBatch(messages);

  const existing = new Set(db.txns.map(fingerprint));
  const added = [];

  for (const txn of parsed) {
    const fp = fingerprint(txn);
    if (existing.has(fp)) continue;
    existing.add(fp);

    const result = categorise(txn, db.learning);
    txn.id = nextId();
    txn.category = result.category;
    txn.categorySource = result.source;
    txn.categoryConfidence = result.confidence;
    txn.needsReview = txn.needsReview || shouldAskLlm(result, txn);
    txn.excluded = false;
    added.push(txn);
  }

  db.txns.push(...added);
  db.txns.sort((a, b) => b.ts - a.ts);
  db.meta.lastImport = Date.now();
  db.meta.importCount = (db.meta.importCount || 0) + 1;

  markDuplicates(db.txns);
  commit();

  return {
    added: added.length,
    skipped: parsed.length - added.length,
    rejected: rejected.length,
    reasons,
    needsReview: added.filter((t) => t.needsReview).length,
    addedTxns: added,
  };
}

/** Convenience wrapper for the paste box. */
export function ingestPastedText(text) {
  return ingest(splitPastedSms(text));
}

/**
 * Import an "SMS Backup & Restore" XML export.
 * That app writes <sms address="VM-HDFCBK" body="..." date="epochMillis" />.
 */
export function ingestSmsBackupXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('That file is not valid XML. Export again from SMS Backup & Restore.');
  }
  const nodes = [...doc.querySelectorAll('sms')];
  if (!nodes.length) throw new Error('No <sms> entries found in that file.');

  const messages = nodes.map((n) => ({
    body: n.getAttribute('body') || '',
    sender: n.getAttribute('address') || '',
    ts: parseInt(n.getAttribute('date') || '0', 10) || Date.now(),
  })).filter((m) => m.body);

  return ingest(messages);
}

/** Import a previously exported Kuber JSON backup. */
export function importBackup(jsonText, { merge = false } = {}) {
  const incoming = JSON.parse(jsonText);
  if (!incoming || !Array.isArray(incoming.txns)) throw new Error('Not a Kuber backup file.');

  if (!merge) {
    db = { ...emptyDb(), ...incoming };
    commit();
    return { added: incoming.txns.length, skipped: 0 };
  }

  const existing = new Set(db.txns.map(fingerprint));
  let added = 0;
  for (const txn of incoming.txns) {
    if (existing.has(fingerprint(txn))) continue;
    db.txns.push({ ...txn, id: nextId() });
    added++;
  }
  db.txns.sort((a, b) => b.ts - a.ts);
  markDuplicates(db.txns);
  commit();
  return { added, skipped: incoming.txns.length - added };
}

export function exportBackup() {
  return JSON.stringify({ ...db, exportedAt: Date.now() }, null, 2);
}

// --- Mutations --------------------------------------------------------------

/**
 * Recategorise a transaction. Also records the correction so every future
 * transaction from that merchant lands in the right place — this is the
 * "learns from your behaviour" loop, and it is intentionally deterministic
 * rather than model-based so a correction is always honoured exactly once.
 */
export function recategorise(txnId, category, { learn = true } = {}) {
  const txn = db.txns.find((t) => t.id === txnId);
  if (!txn) return;
  txn.category = category;
  txn.categorySource = 'user';
  txn.categoryConfidence = 1;
  txn.needsReview = false;

  if (learn && txn.merchant && txn.merchant !== 'Unknown') {
    db.learning.overrides[txn.merchant] = category;
    // Retroactively fix every other transaction from this merchant that the
    // user has not explicitly touched.
    for (const other of db.txns) {
      if (other.id !== txnId && other.merchant === txn.merchant && other.categorySource !== 'user') {
        other.category = category;
        other.categorySource = 'learned';
        other.needsReview = false;
      }
    }
  }
  commit();
}

export function renameMerchant(txnId, merchant) {
  const txn = db.txns.find((t) => t.id === txnId);
  if (!txn) return;
  const old = txn.merchant;
  for (const t of db.txns) if (t.merchant === old) t.merchant = merchant;
  commit();
}

export function setExcluded(txnId, excluded) {
  const txn = db.txns.find((t) => t.id === txnId);
  if (txn) { txn.excluded = excluded; commit(); }
}

export function deleteTxn(txnId) {
  db.txns = db.txns.filter((t) => t.id !== txnId);
  markDuplicates(db.txns);
  commit();
}

export function addManualTxn({ amount, merchant, category, direction = 'debit', ts = Date.now(), note = '' }) {
  db.txns.push({
    id: nextId(), raw: note || `Manual entry: ${merchant}`, source: 'manual', sender: '',
    receivedAt: ts, ts, amount: Number(amount), direction, merchant, merchantRaw: merchant,
    category, categorySource: 'user', categoryConfidence: 1, bank: null, accountLast4: null,
    cardLast4: null, vpa: null, refId: null, balance: null, mode: 'other', flags: {},
    confidence: 1, needsReview: false, excluded: false, note,
  });
  db.txns.sort((a, b) => b.ts - a.ts);
  commit();
}

export function setBudget(category, amount) {
  if (amount == null || amount === '') delete db.budgets[category];
  else db.budgets[category] = Number(amount);
  commit();
}

export function applySuggestedBudgets() {
  db.budgets = { ...suggestBudgets(db.txns), ...db.budgets };
  commit();
  return db.budgets;
}

export function addGoal(goal) {
  db.goals.push({ id: nextId(), createdAt: Date.now(), saved: 0, ...goal });
  commit();
}

export function updateGoal(id, patch) {
  const g = db.goals.find((x) => x.id === id);
  if (g) { Object.assign(g, patch); commit(); }
}

export function deleteGoal(id) {
  db.goals = db.goals.filter((g) => g.id !== id);
  commit();
}

export function addRule(pattern, category) {
  db.learning.rules.push({ id: nextId(), pattern, category });
  commit();
}

export function deleteRule(id) {
  db.learning.rules = db.learning.rules.filter((r) => r.id !== id);
  commit();
}

/** Re-run categorisation over everything, respecting user overrides. */
export function recategoriseAll() {
  let changed = 0;
  for (const txn of db.txns) {
    if (txn.categorySource === 'user') continue;
    const result = categorise(txn, db.learning);
    if (result.category !== txn.category) changed++;
    txn.category = result.category;
    txn.categorySource = result.source;
    txn.categoryConfidence = result.confidence;
  }
  commit();
  return changed;
}

export function updateProfile(patch) { Object.assign(db.profile, patch); commit(); }
export function updateSettings(patch) { Object.assign(db.settings, patch); commit(); }

// --- Derived state ----------------------------------------------------------

let cache = null;
let cacheKey = '';

/**
 * Compute everything the UI needs. Memoised on transaction count + last-write
 * so switching tabs does not recompute the whole analytics stack.
 */
export function derive({ force = false } = {}) {
  const key = `${db.txns.length}|${db.meta.lastImport}|${JSON.stringify(db.budgets)}|${db.txns.filter((t) => t.categorySource === 'user').length}`;
  if (!force && cache && cacheKey === key) return cache;

  const now = Date.now();
  const txns = db.txns;
  const active = txns.filter((t) => !t.duplicateOf && !t.excluded);

  const recurring = detectRecurring(txns);
  const forecast = forecastMonth(txns, recurring, now);
  const anomalies = detectAnomalies(txns);
  const health = healthScore(txns, recurring, now);
  const upcoming = upcomingPayments(recurring, 30, now);

  const monthStart = startOfMonth(now);
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const thisMonthTxns = active.filter((t) => t.ts >= monthStart);

  // Latest reported balance per account, then summed — the closest thing to a
  // real balance we can get from SMS alone.
  const balances = new Map();
  for (const t of [...txns].sort((a, b) => a.ts - b.ts)) {
    if (t.balance != null && t.accountLast4) balances.set(t.accountLast4, { amount: t.balance, ts: t.ts, bank: t.bank });
  }
  const balance = [...balances.values()].reduce((a, b) => a + b.amount, 0);

  const state = {
    now,
    txns,
    active,
    recurring,
    subscriptions: recurring.filter((r) => r.isSubscription),
    commitments: recurring.filter((r) => r.isCommitment),
    upcoming,
    forecast,
    anomalies,
    health,
    balance,
    balancesByAccount: [...balances.entries()].map(([last4, v]) => ({ last4, ...v })),
    budgets: db.budgets,
    goals: db.goals,
    monthly: monthlyTotals(txns),
    daily: dailyTotals(txns, 90, now),
    categories: categoryTotals(thisMonthTxns),
    categoriesAllTime: categoryTotals(active),
    todaySpend: sum(active.filter((t) => t.ts >= todayStart && isSpend(t))),
    monthSpend: sum(thisMonthTxns.filter(isSpend)),
    monthIncome: sum(thisMonthTxns.filter((t) => t.direction === 'credit' && !t.flags?.failed)),
    needsReview: txns.filter((t) => t.needsReview && !t.duplicateOf),
    duplicates: txns.filter((t) => t.duplicateOf),
    totalBudget: Object.values(db.budgets).reduce((a, b) => a + b, 0),
  };

  state.insights = generateInsights(state, now)
    .filter((i) => !db.dismissedInsights.includes(i.title));

  cache = state;
  cacheKey = key;
  return state;
}

export function invalidate() { cache = null; }

export function dismissInsight(title) {
  db.dismissedInsights.push(title);
  commit();
}

export { parseSms, splitPastedSms };
