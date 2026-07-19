/**
 * Categorisation engine.
 *
 * Resolution order (first hit wins):
 *   1. User override for this merchant  — learned corrections, never overruled
 *   2. Explicit user rule               — "anything matching X is Y"
 *   3. Merchant dictionary suggestion   — from parser
 *   4. Keyword heuristics               — this file
 *   5. Payment-mode default             — ATM → Cash Withdrawal, etc.
 *   6. LLM fallback                     — engine/llm.js, only if configured
 *   7. 'Miscellaneous'
 *
 * Steps 1–5 are offline and free, which is what keeps the hybrid cheap: on a
 * typical Indian SMS corpus they resolve ~90% of messages.
 */

export const CATEGORIES = [
  'Food Delivery', 'Restaurants', 'Groceries', 'Fuel', 'Transport', 'Travel',
  'Shopping', 'Medical', 'Healthcare', 'Beauty', 'Education', 'Entertainment',
  'Rent', 'Utilities', 'Bills', 'Recharge', 'Salary', 'Freelance', 'Investment',
  'Insurance', 'EMI', 'Loan', 'Tax', 'Business', 'Gifts', 'Cash Withdrawal',
  'Transfer', 'Kids', 'Pets', 'Home', 'Savings', 'Miscellaneous',
];

/** Categories that represent money moving in, not spending. */
export const INCOME_CATEGORIES = new Set(['Salary', 'Freelance']);

/** Categories excluded from "spending" totals — they are moves, not costs. */
export const NON_SPEND_CATEGORIES = new Set(['Transfer', 'Savings', 'Investment', 'Cash Withdrawal']);

export const CATEGORY_META = {
  'Food Delivery':   { icon: '🍔', color: '#ff7043' },
  'Restaurants':     { icon: '🍽️', color: '#ff8a65' },
  'Groceries':       { icon: '🛒', color: '#66bb6a' },
  'Fuel':            { icon: '⛽', color: '#8d6e63' },
  'Transport':       { icon: '🚕', color: '#ffca28' },
  'Travel':          { icon: '✈️', color: '#29b6f6' },
  'Shopping':        { icon: '🛍️', color: '#ab47bc' },
  'Medical':         { icon: '💊', color: '#ef5350' },
  'Healthcare':      { icon: '🩺', color: '#ec407a' },
  'Beauty':          { icon: '💄', color: '#f06292' },
  'Education':       { icon: '📚', color: '#5c6bc0' },
  'Entertainment':   { icon: '🎬', color: '#7e57c2' },
  'Rent':            { icon: '🏠', color: '#78909c' },
  'Utilities':       { icon: '💡', color: '#26a69a' },
  'Bills':           { icon: '🧾', color: '#26c6da' },
  'Recharge':        { icon: '📱', color: '#42a5f5' },
  'Salary':          { icon: '💰', color: '#2e7d32' },
  'Freelance':       { icon: '💼', color: '#388e3c' },
  'Investment':      { icon: '📈', color: '#1e88e5' },
  'Insurance':       { icon: '🛡️', color: '#5e35b1' },
  'EMI':             { icon: '🏦', color: '#d81b60' },
  'Loan':            { icon: '📉', color: '#c2185b' },
  'Tax':             { icon: '🏛️', color: '#6d4c41' },
  'Business':        { icon: '🏢', color: '#455a64' },
  'Gifts':           { icon: '🎁', color: '#ff4081' },
  'Cash Withdrawal': { icon: '🏧', color: '#9e9e9e' },
  'Transfer':        { icon: '🔁', color: '#90a4ae' },
  'Kids':            { icon: '🧸', color: '#ffb74d' },
  'Pets':            { icon: '🐾', color: '#a1887f' },
  'Home':            { icon: '🛋️', color: '#8d6e63' },
  'Savings':         { icon: '🐖', color: '#43a047' },
  'Miscellaneous':   { icon: '📦', color: '#bdbdbd' },
};

/**
 * Keyword heuristics, evaluated in order. Deliberately narrow — a false
 * category is worse than 'Miscellaneous' because the user has to undo it.
 */
const KEYWORD_RULES = [
  { category: 'Salary',          re: /\b(salary|payroll|sal cr|wages|stipend)\b/i },
  { category: 'EMI',             re: /\b(emi|equated monthly|instal?ment)\b/i },
  { category: 'Loan',            re: /\b(loan|principal|disbursement|bnpl)\b/i },
  { category: 'Investment',      re: /\b(sip|mutual fund|mf |folio|nps|ppf|elss|zerodha|groww|upstox|demat|nse|bse)\b/i },
  { category: 'Insurance',       re: /\b(insurance|premium|policy no|lic |assurance)\b/i },
  { category: 'Rent',            re: /\b(rent|landlord|nobroker|rentpay|housing society|maintenance charge)\b/i },
  { category: 'Cash Withdrawal', re: /\b(atm|cash w(?:ithdraw|dl)|cash withdrawal)\b/i },
  { category: 'Fuel',            re: /\b(petrol|diesel|fuel|petroleum|filling station)\b/i },
  { category: 'Utilities',       re: /\b(electricity|power bill|water bill|gas bill|lpg|discom)\b/i },
  { category: 'Recharge',        re: /\b(recharge|prepaid|top ?up|mobile bill|data pack)\b/i },
  { category: 'Bills',           re: /\b(broadband|fiber|fibre|dth|landline|bill payment|billdesk)\b/i },
  { category: 'Tax',             re: /\b(income tax|gst|tds|advance tax|challan|itr)\b/i },
  { category: 'Medical',         re: /\b(pharmacy|medical|hospital|clinic|diagnostic|lab test|chemist|medicine)\b/i },
  { category: 'Healthcare',      re: /\b(gym|fitness|doctor|dental|therapy|wellness)\b/i },
  { category: 'Education',       re: /\b(school|college|university|tuition|course|exam fee|admission)\b/i },
  { category: 'Groceries',       re: /\b(supermarket|kirana|grocery|provision|mart)\b/i },
  { category: 'Restaurants',     re: /\b(restaurant|cafe|coffee|bakery|hotel food|dhaba|bar & )\b/i },
  { category: 'Transport',       re: /\b(cab|taxi|auto fare|metro|bus ticket|parking|toll|fastag)\b/i },
  { category: 'Travel',          re: /\b(flight|airline|hotel booking|resort|travel|tourism|visa fee)\b/i },
  { category: 'Entertainment',   re: /\b(movie|cinema|multiplex|subscription|streaming|game|concert)\b/i },
  { category: 'Shopping',        re: /\b(store|retail|fashion|apparel|electronics|mall)\b/i },
  { category: 'Transfer',        re: /\b(imps|neft|rtgs|fund transfer|sent to|self transfer|upi p2p)\b/i },
];

const MODE_DEFAULTS = {
  atm: 'Cash Withdrawal',
  emi: 'EMI',
  autodebit: 'Bills',
  imps: 'Transfer',
  neft: 'Transfer',
  rtgs: 'Transfer',
};

/**
 * Categorise one transaction.
 *
 * @param {object} txn      parsed transaction
 * @param {object} learning { overrides: {merchant: category}, rules: [{pattern, category}] }
 * @returns {{category: string, source: string, confidence: number}}
 */
export function categorise(txn, learning = {}) {
  const overrides = learning.overrides || {};
  const rules = learning.rules || [];
  const haystack = `${txn.merchant || ''} ${txn.merchantRaw || ''} ${txn.raw || ''}`;

  // 1. Learned override, keyed on the canonical merchant.
  if (txn.merchant && overrides[txn.merchant]) {
    return { category: overrides[txn.merchant], source: 'user', confidence: 1 };
  }

  // 2. Explicit user rules.
  for (const rule of rules) {
    if (!rule.pattern) continue;
    try {
      if (new RegExp(rule.pattern, 'i').test(haystack)) {
        return { category: rule.category, source: 'rule', confidence: 0.98 };
      }
    } catch {
      // A malformed user regex should never break categorisation.
    }
  }

  // Income short-circuit: a credit that looks like pay is Salary regardless.
  if (txn.direction === 'credit') {
    if (/\b(salary|payroll|sal cr|wages)\b/i.test(haystack)) {
      return { category: 'Salary', source: 'keyword', confidence: 0.95 };
    }
    if (txn.flags?.refund) {
      return { category: 'Miscellaneous', source: 'refund', confidence: 0.7 };
    }
  }

  // 3. Merchant dictionary.
  if (txn.suggestedCategory) {
    return { category: txn.suggestedCategory, source: 'dictionary', confidence: 0.9 };
  }

  // 4. Keyword heuristics.
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(haystack)) {
      return { category: rule.category, source: 'keyword', confidence: 0.72 };
    }
  }

  // 5. Payment-mode default.
  if (MODE_DEFAULTS[txn.mode]) {
    return { category: MODE_DEFAULTS[txn.mode], source: 'mode', confidence: 0.55 };
  }

  return { category: 'Miscellaneous', source: 'fallback', confidence: 0.3 };
}

/** True when the result is weak enough to be worth an LLM call. */
export function shouldAskLlm(result, txn) {
  if (result.source === 'user' || result.source === 'rule') return false;
  return result.confidence < 0.7 || txn.merchant === 'Unknown';
}
