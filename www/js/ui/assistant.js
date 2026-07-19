/**
 * Natural-language querying.
 *
 * Two consumers share the same intent parser:
 *   - the search box on the Activity tab (filters the list)
 *   - the Ask tab (answers a question in prose)
 *
 * The local engine handles the question shapes that actually recur — "how much
 * on X", "show all Y", "when is my next Z", "can I afford N" — deterministically
 * and offline. Anything it cannot classify falls through to the LLM if one is
 * configured, and to an honest "I can't answer that" if not.
 */

import { CATEGORIES, CATEGORY_META } from '../engine/categorizer.js';
import {
  formatINR, sum, isSpend, monthKey, startOfMonth, categoryTotals, canAfford,
} from '../engine/intelligence.js';
import { ask as llmAsk, getConfig } from '../engine/llm.js';

const DAY = 86_400_000;

// --- Query parsing ----------------------------------------------------------

const PERIOD_PATTERNS = [
  { re: /\b(today)\b/i,                    resolve: (n) => ({ from: new Date(n).setHours(0, 0, 0, 0), to: n, label: 'today' }) },
  { re: /\b(yesterday)\b/i,                resolve: (n) => { const s = new Date(n).setHours(0, 0, 0, 0) - DAY; return { from: s, to: s + DAY - 1, label: 'yesterday' }; } },
  { re: /\bthis week\b/i,                  resolve: (n) => ({ from: new Date(n).setHours(0, 0, 0, 0) - new Date(n).getDay() * DAY, to: n, label: 'this week' }) },
  { re: /\blast week\b/i,                  resolve: (n) => { const s = new Date(n).setHours(0, 0, 0, 0) - (new Date(n).getDay() + 7) * DAY; return { from: s, to: s + 7 * DAY - 1, label: 'last week' }; } },
  { re: /\bthis month\b/i,                 resolve: (n) => ({ from: startOfMonth(n), to: n, label: 'this month' }) },
  { re: /\blast month\b/i,                 resolve: (n) => { const d = new Date(n); const from = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(); return { from, to: startOfMonth(n) - 1, label: 'last month' }; } },
  { re: /\bthis year\b/i,                  resolve: (n) => ({ from: new Date(new Date(n).getFullYear(), 0, 1).getTime(), to: n, label: 'this year' }) },
  { re: /\blast (\d{1,3}) days?\b/i,       resolve: (n, m) => ({ from: n - parseInt(m[1], 10) * DAY, to: n, label: `the last ${m[1]} days` }) },
  { re: /\bpast (\d{1,3}) days?\b/i,       resolve: (n, m) => ({ from: n - parseInt(m[1], 10) * DAY, to: n, label: `the last ${m[1]} days` }) },
];

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const MODE_WORDS = {
  upi: 'upi', card: 'card', atm: 'atm', cash: 'atm', neft: 'neft', imps: 'imps',
  rtgs: 'rtgs', emi: 'emi', wallet: 'wallet', netbanking: 'netbanking',
};

/**
 * Extract structured filters from a free-text query.
 * Every field is optional; an empty result means "no filter".
 */
export function parseQuery(text, now = Date.now()) {
  const q = String(text || '').trim();
  const lower = q.toLowerCase();
  const filters = { text: q };

  // Period
  for (const p of PERIOD_PATTERNS) {
    const m = lower.match(p.re);
    if (m) { Object.assign(filters, p.resolve(now, m)); break; }
  }
  if (!filters.from) {
    const monthIdx = MONTH_NAMES.findIndex((name) => new RegExp(`\\b${name}\\b|\\b${name.slice(0, 3)}\\b`, 'i').test(lower));
    if (monthIdx >= 0) {
      const year = (lower.match(/\b(20\d{2})\b/) || [])[1];
      const y = year ? parseInt(year, 10) : new Date(now).getFullYear();
      filters.from = new Date(y, monthIdx, 1).getTime();
      filters.to = new Date(y, monthIdx + 1, 0, 23, 59, 59).getTime();
      filters.label = `${MONTH_NAMES[monthIdx][0].toUpperCase()}${MONTH_NAMES[monthIdx].slice(1)} ${y}`;
    }
  }

  // Amount comparisons
  const above = lower.match(/\b(?:above|over|more than|greater than|>)\s*(?:rs\.?|inr|₹)?\s*([\d,]+)/i);
  if (above) filters.minAmount = parseFloat(above[1].replace(/,/g, ''));
  const below = lower.match(/\b(?:below|under|less than|<)\s*(?:rs\.?|inr|₹)?\s*([\d,]+)/i);
  if (below) filters.maxAmount = parseFloat(below[1].replace(/,/g, ''));

  // Category — match on the canonical list.
  for (const category of CATEGORIES) {
    if (new RegExp(`\\b${category.toLowerCase().replace(/\s+/g, '\\s+')}\\b`, 'i').test(lower)) {
      filters.category = category;
      break;
    }
  }
  // A few common synonyms the canonical names miss.
  if (!filters.category) {
    if (/\b(food|eating out|dining|restaurant)\b/.test(lower)) filters.category = 'Food Delivery';
    else if (/\b(petrol|diesel|gas station)\b/.test(lower)) filters.category = 'Fuel';
    else if (/\b(cab|taxi|uber|ola|commute)\b/.test(lower)) filters.category = 'Transport';
    else if (/\b(subscription|subscriptions)\b/.test(lower)) filters.subscriptionsOnly = true;
  }

  // Payment mode
  for (const [word, mode] of Object.entries(MODE_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) { filters.mode = mode; break; }
  }

  // Direction
  if (/\b(income|credited|received|salary|refund)\b/.test(lower)) filters.direction = 'credit';
  else if (/\b(spent|spend|paid|debited|expense)\b/.test(lower)) filters.direction = 'debit';

  // Free-text merchant: whatever is left after stripping the structural words.
  const residue = lower
    .replace(/\b(how much|did i|do i|show|all|list|find|my|on|in|the|last|this|month|week|year|days?|spend|spent|paid|total|of|for|at|from|above|over|under|below|more|less|than|rs|inr|₹|[\d,]+)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (residue.length >= 3) filters.merchantText = residue;

  return filters;
}

/** Apply parsed filters to the transaction list. */
export function applyFilters(txns, filters) {
  return txns.filter((t) => {
    if (t.duplicateOf && !filters.includeDuplicates) return false;
    if (filters.from && t.ts < filters.from) return false;
    if (filters.to && t.ts > filters.to) return false;
    if (filters.category && t.category !== filters.category) return false;
    if (filters.mode && t.mode !== filters.mode) return false;
    if (filters.direction && t.direction !== filters.direction) return false;
    if (filters.minAmount && t.amount < filters.minAmount) return false;
    if (filters.maxAmount && t.amount > filters.maxAmount) return false;
    if (filters.merchantText) {
      const hay = `${t.merchant} ${t.merchantRaw || ''} ${t.category} ${t.bank || ''} ${t.raw}`.toLowerCase();
      const words = filters.merchantText.split(' ').filter((w) => w.length >= 3);
      if (words.length && !words.some((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

// --- Answering --------------------------------------------------------------

/**
 * Answer a question locally where possible.
 * Returns { text, txns?, handled } — `handled: false` means hand off to the LLM.
 */
export function answerLocally(question, state) {
  const q = String(question || '').trim();
  const lower = q.toLowerCase();
  const now = state.now || Date.now();

  // --- Affordability ---
  const afford = lower.match(/\b(?:can i afford|afford)\b.*?(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|lakh|l|cr|crore)?/i);
  if (afford) {
    let amount = parseFloat(afford[1].replace(/,/g, ''));
    const unit = (afford[2] || '').toLowerCase();
    if (unit === 'k' || unit === 'thousand') amount *= 1_000;
    else if (unit === 'lakh' || unit === 'l') amount *= 100_000;
    else if (unit === 'cr' || unit === 'crore') amount *= 10_000_000;

    const r = canAfford(amount, state, now);
    const verdict = r.verdict === 'yes'
      ? `**Yes.** After committed payments you should have about ${formatINR(r.available)} of headroom this month.`
      : r.verdict === 'tight'
        ? `**It would be tight.** You have roughly ${formatINR(r.available)} of headroom now, so ${formatINR(amount)} would need next month's income to land first.`
        : `**Not comfortably.** Projected headroom is ${formatINR(r.available)}, which is short of ${formatINR(amount)}.`;
    const plan = r.monthsToSave ? ` Saving 20% of a typical ${formatINR(r.avgIncome)} month, you would get there in about ${r.monthsToSave} month${r.monthsToSave > 1 ? 's' : ''}.` : '';
    return { handled: true, text: `${verdict} That is against a current balance of ${formatINR(r.balance)}, with ${formatINR(r.committed)} of recurring payments still due.${plan}` };
  }

  // --- Next recurring payment ---
  const next = lower.match(/\b(?:when|next).*(emi|sip|rent|bill|subscription|payment|renewal|due)/i);
  if (next || /\bwhat(?:'s| is) (?:due|coming|next)\b/i.test(lower)) {
    const keyword = (next && next[1]) || '';
    let items = state.upcoming || [];
    if (keyword && keyword !== 'payment' && keyword !== 'due') {
      items = items.filter((r) =>
        r.merchant.toLowerCase().includes(keyword) ||
        r.category.toLowerCase().includes(keyword) ||
        (keyword === 'subscription' && r.isSubscription));
    }
    if (!items.length) return { handled: true, text: `I don't see any ${keyword || 'recurring'} payments due in the next 30 days.` };
    const lines = items.slice(0, 6).map((r) => {
      const days = Math.round((r.nextDue - now) / DAY);
      const when = days <= 0 ? 'due now' : days === 1 ? 'tomorrow' : `in ${days} days`;
      return `• **${r.merchant}** — ${formatINR(r.avgAmount)} ${when} (${new Date(r.nextDue).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})`;
    });
    return { handled: true, text: `Coming up:\n${lines.join('\n')}\n\nThat is ${formatINR(sum(items, (r) => r.avgAmount))} in total over the next 30 days.` };
  }

  // --- Subscription audit ---
  if (/\b(subscription|subscriptions|recurring)\b/.test(lower) && /\b(how much|total|wast|cut|cost|spend|paying)\b/.test(lower)) {
    const subs = state.subscriptions || [];
    if (!subs.length) return { handled: true, text: 'I have not detected any subscriptions yet. That usually needs two or three billing cycles of history.' };
    const monthly = sum(subs, (r) => (r.cadence === 'monthly' ? r.avgAmount : r.avgAmount / (r.cadenceDays / 30.4)));
    const sorted = [...subs].sort((a, b) => b.avgAmount - a.avgAmount);
    const lines = sorted.slice(0, 8).map((r) => `• **${r.merchant}** — ${formatINR(r.avgAmount)} / ${r.cadence}`);
    return {
      handled: true,
      text: `You have ${subs.length} recurring subscriptions costing about **${formatINR(monthly)} a month** — ${formatINR(monthly * 12)} a year.\n\n${lines.join('\n')}\n\nThe cheapest win is usually the largest one you have not opened in a month.`,
    };
  }

  // --- Health score ---
  if (/\b(health|score|how am i doing|financial health)\b/.test(lower)) {
    const h = state.health;
    const lines = h.components.map((c) => `• ${c.label}: ${Math.round(c.score * 100)}/100 — ${c.detail}`);
    return { handled: true, text: `Your financial health score is **${h.score}/100 (${h.grade})**.\n\n${lines.join('\n')}` };
  }

  // --- Forecast ---
  if (/\b(predict|forecast|projection|month end|end of month|will i spend|expected)\b/.test(lower)) {
    const f = state.forecast;
    return {
      handled: true,
      text: `You have spent **${formatINR(f.spentSoFar)}** so far this month. With ${formatINR(f.committed)} of recurring payments still due and a run rate of ${formatINR(f.dailyRate)}/day over ${f.daysLeft} remaining days, I project **${formatINR(f.projected)}** by month end — ${f.vsAverage > 0 ? `${Math.round(f.vsAverage * 100)}% above` : `${Math.abs(Math.round(f.vsAverage * 100))}% below`} your ${formatINR(f.avgPastMonths)} average.`,
    };
  }

  // --- Why did spending change ---
  if (/\bwhy\b.*\b(increase|higher|more|up|rise|spike|change)\b/.test(lower)) {
    const months = state.monthly;
    const cur = months[months.length - 1];
    const prev = months[months.length - 2];
    if (!cur || !prev) return { handled: true, text: 'I need at least two months of history to compare.' };

    const curCats = categoryTotals(state.txns.filter((t) => monthKey(t.ts) === cur.key));
    const prevMap = new Map(categoryTotals(state.txns.filter((t) => monthKey(t.ts) === prev.key)).map((c) => [c.category, c.amount]));
    const deltas = curCats
      .map((c) => ({ category: c.category, delta: c.amount - (prevMap.get(c.category) || 0), amount: c.amount }))
      .filter((d) => Math.abs(d.delta) > 100)
      .sort((a, b) => b.delta - a.delta);

    if (!deltas.length) return { handled: true, text: 'Spending is broadly flat versus last month — no category moved by more than ₹100.' };
    const total = cur.spend - prev.spend;
    const up = deltas.slice(0, 3).filter((d) => d.delta > 0);
    const down = deltas.slice(-3).filter((d) => d.delta < 0).reverse();
    const lines = up.map((d) => `• **${d.category}** up ${formatINR(d.delta)} (now ${formatINR(d.amount)})`);

    // When the total actually fell, leading with what rose is misleading — the
    // categories that dropped are the answer to the question being asked.
    if (total < 0) {
      const cuts = down.map((d) => `• **${d.category}** down ${formatINR(Math.abs(d.delta))}`);
      return {
        handled: true,
        text: `Spending actually went **down** ${formatINR(Math.abs(total))} versus last month.\n\n${cuts.length ? `Biggest reductions:\n${cuts.join('\n')}\n\n` : ''}${lines.length ? `These did rise, but not enough to offset it:\n${lines.join('\n')}` : ''}`,
      };
    }

    return {
      handled: true,
      text: `Spending moved up ${formatINR(total)} versus last month.\n\n${lines.join('\n')}\n\n${up[0] ? `${up[0].category} accounts for most of the increase.` : ''}`,
    };
  }

  // --- What should I cut ---
  if (/\b(what should i cut|save money|reduce|cut back|trim)\b/.test(lower)) {
    const cats = state.categories.filter((c) => !['Rent', 'EMI', 'Insurance', 'Utilities', 'Loan'].includes(c.category));
    if (!cats.length) return { handled: true, text: 'I do not have enough discretionary spending recorded to suggest cuts yet.' };
    const top = cats.slice(0, 3);
    const subs = state.subscriptions || [];
    const subLine = subs.length
      ? `\n\nYou also pay ${formatINR(sum(subs, (r) => r.avgAmount))} across ${subs.length} subscriptions — the fastest cut is usually the least-used one.`
      : '';
    return {
      handled: true,
      text: `Your largest discretionary categories this month:\n${top.map((c) => `• **${c.category}** — ${formatINR(c.amount)} (${Math.round(c.share * 100)}% of spend)`).join('\n')}\n\nA 20% trim on ${top[0].category} alone would free ${formatINR(top[0].amount * 0.2)} a month, or ${formatINR(top[0].amount * 0.2 * 12)} a year.${subLine}`,
    };
  }

  // --- Aggregation: "how much did I spend on X" ---
  if (/\b(how much|total|sum)\b/.test(lower)) {
    const filters = parseQuery(q, now);
    const matched = applyFilters(state.txns, filters).filter((t) => (filters.direction === 'credit' ? t.direction === 'credit' : isSpend(t)));
    const total = sum(matched);
    if (!matched.length) return { handled: true, text: `I could not find any transactions matching that.` };

    const scope = [
      filters.category ? `on ${filters.category}` : '',
      filters.merchantText && !filters.category ? `at ${filters.merchantText}` : '',
      filters.label ? filters.label : '',
      filters.mode ? `via ${filters.mode.toUpperCase()}` : '',
    ].filter(Boolean).join(' ');

    const byMerchant = new Map();
    for (const t of matched) byMerchant.set(t.merchant, (byMerchant.get(t.merchant) || 0) + t.amount);
    const top = [...byMerchant.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

    return {
      handled: true,
      txns: matched,
      text: `**${formatINR(total)}** across ${matched.length} transaction${matched.length > 1 ? 's' : ''} ${scope}.\n\nTop: ${top.map(([m, a]) => `${m} (${formatINR(a)})`).join(', ')}.\nAverage per transaction: ${formatINR(total / matched.length)}.`,
    };
  }

  // --- Listing: "show all X" ---
  if (/\b(show|list|find|all|every)\b/.test(lower)) {
    const filters = parseQuery(q, now);
    const matched = applyFilters(state.txns, filters);
    if (!matched.length) return { handled: true, text: 'Nothing matched that search.' };
    return {
      handled: true,
      txns: matched,
      text: `Found **${matched.length}** transactions totalling ${formatINR(sum(matched.filter(isSpend)))}. They are listed below.`,
    };
  }

  return { handled: false };
}

/**
 * Compact aggregate summary handed to the LLM. Aggregates only — no raw SMS,
 * no account numbers, no references. The model gets enough to reason about
 * patterns and nothing that could identify an account.
 */
export function buildSummary(state) {
  const subs = state.subscriptions || [];
  return {
    currency: 'INR',
    asOf: new Date(state.now).toISOString().slice(0, 10),
    currentBalance: Math.round(state.balance),
    thisMonth: {
      spend: Math.round(state.monthSpend),
      income: Math.round(state.monthIncome),
      projectedSpend: state.forecast.projected,
      dailyRate: state.forecast.dailyRate,
      daysLeft: state.forecast.daysLeft,
    },
    monthlyHistory: state.monthly.slice(-6).map((m) => ({ month: m.key, spend: Math.round(m.spend), income: Math.round(m.income) })),
    topCategoriesThisMonth: state.categories.slice(0, 10).map((c) => ({ category: c.category, amount: Math.round(c.amount), sharePct: Math.round(c.share * 100) })),
    subscriptions: subs.map((r) => ({ merchant: r.merchant, amount: Math.round(r.avgAmount), cadence: r.cadence })),
    upcomingPayments: (state.upcoming || []).map((r) => ({ merchant: r.merchant, amount: Math.round(r.avgAmount), dueDate: new Date(r.nextDue).toISOString().slice(0, 10) })),
    budgets: state.budgets,
    healthScore: { score: state.health.score, grade: state.health.grade, savingsRatePct: Math.round(state.health.savingsRate * 100) },
    transactionCount: state.txns.length,
  };
}

/**
 * Full answer path: local engine, then LLM, then an honest failure.
 */
export async function answer(question, state) {
  const local = answerLocally(question, state);
  if (local.handled) return { ...local, source: 'local' };

  if (getConfig()) {
    const result = await llmAsk(question, buildSummary(state));
    if (result.text) return { text: result.text, source: 'llm' };
    return {
      text: `I could not reach the AI service (${result.error}). Try rephrasing, or ask something like "how much did I spend on food last month".`,
      source: 'error',
    };
  }

  return {
    source: 'none',
    text: `I can't answer that one with the built-in rules. I handle questions like:\n\n• "How much did I spend on food last month?"\n• "Show all Amazon purchases"\n• "When is my next EMI?"\n• "Can I afford ₹50,000?"\n• "Why did my spending increase?"\n• "How much am I wasting on subscriptions?"\n\nFor anything broader, add an API key in Settings → AI and I'll use a model for open-ended questions.`,
  };
}

export const SUGGESTIONS = [
  'How much did I spend on food last month?',
  'What is due in the next 30 days?',
  'How much am I wasting on subscriptions?',
  'Why did my spending increase?',
  'Can I afford ₹50,000?',
  'What should I cut?',
  'Predict my month-end spending',
  'How is my financial health?',
];

export { CATEGORY_META };
