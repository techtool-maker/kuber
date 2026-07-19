/**
 * Intelligence layer — everything derived from the transaction set.
 *
 * Duplicate detection, recurring/subscription discovery, cash-flow forecasting,
 * anomaly detection, budget generation, financial health scoring and insight
 * generation. All pure functions over an array of transactions so they can be
 * unit-tested and ported without change.
 */

import { NON_SPEND_CATEGORIES, INCOME_CATEGORIES } from './categorizer.js';

const DAY = 86_400_000;

// --- Small shared helpers ---------------------------------------------------

export const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const startOfMonth = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
export const monthKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
export const daysInMonth = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };

export const isSpend = (t) => t.direction === 'debit' && !t.excluded && !NON_SPEND_CATEGORIES.has(t.category) && !t.flags?.failed;
export const isIncome = (t) => t.direction === 'credit' && !t.excluded && INCOME_CATEGORIES.has(t.category);

export const sum = (arr, pick = (x) => x.amount) => arr.reduce((a, b) => a + (pick(b) || 0), 0);

export function formatINR(amount, { compact = false } = {}) {
  const n = Number(amount) || 0;
  if (compact) {
    const abs = Math.abs(n);
    if (abs >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)}Cr`;
    if (abs >= 100_000) return `₹${(n / 100_000).toFixed(2)}L`;
    if (abs >= 1_000) return `₹${(n / 1_000).toFixed(1)}K`;
  }
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

// --- Duplicate detection ----------------------------------------------------

/**
 * Two transactions are duplicates when the same amount hits the same merchant
 * within a short window. Bank + wallet often both SMS the same payment, and
 * double-taps on a payment screen are a real (and expensive) user problem.
 *
 * A shared reference ID is treated as conclusive.
 */
export function markDuplicates(txns, { windowMs = 6 * 60 * 1000 } = {}) {
  const sorted = [...txns].sort((a, b) => a.ts - b.ts);
  const seenRefs = new Map();

  for (const t of sorted) t.duplicateOf = null;

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (t.refId) {
      if (seenRefs.has(t.refId)) { t.duplicateOf = seenRefs.get(t.refId).id; continue; }
      seenRefs.set(t.refId, t);
    }
    for (let j = i - 1; j >= 0; j--) {
      const prev = sorted[j];
      if (t.ts - prev.ts > windowMs) break;
      if (prev.duplicateOf) continue;
      if (prev.amount === t.amount && prev.merchant === t.merchant && prev.direction === t.direction) {
        t.duplicateOf = prev.id;
        break;
      }
    }
  }
  return txns;
}

// --- Recurring & subscription detection -------------------------------------

/**
 * Recurring costs that are structural rather than discretionary. They are
 * still tracked and forecast, but calling rent or a car loan a "subscription
 * you could cancel" is wrong, and it wrecks both the subscription-load score
 * and any advice built on it.
 */
export const COMMITMENT_CATEGORIES = new Set([
  'Rent', 'EMI', 'Loan', 'Insurance', 'Investment', 'Savings', 'Tax',
  'Transfer', 'Cash Withdrawal', 'Salary', 'Freelance',
]);

const CADENCES = [
  { name: 'weekly',    days: 7,   tolerance: 2 },
  { name: 'monthly',   days: 30.4, tolerance: 5 },
  { name: 'quarterly', days: 91,  tolerance: 9 },
  { name: 'yearly',    days: 365, tolerance: 20 },
];

/**
 * Group debits by merchant and look for a stable interval and a stable amount.
 * Requires 2 occurrences for a dictionary-known subscription, 3 otherwise —
 * two coincidental payments to the same shop are common, three on a cadence
 * are not.
 */
export function detectRecurring(txns) {
  const groups = new Map();
  for (const t of txns) {
    if (t.direction !== 'debit' || t.duplicateOf || t.excluded) continue;
    if (!t.merchant || t.merchant === 'Unknown') continue;
    if (!groups.has(t.merchant)) groups.set(t.merchant, []);
    groups.get(t.merchant).push(t);
  }

  const found = [];

  for (const [merchant, list] of groups) {
    list.sort((a, b) => a.ts - b.ts);
    const minOccurrences = list[0]?.knownRecurring ? 2 : 3;
    if (list.length < minOccurrences) continue;

    const gaps = [];
    for (let i = 1; i < list.length; i++) gaps.push((list[i].ts - list[i - 1].ts) / DAY);
    if (!gaps.length) continue;

    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const cadence = CADENCES.find((c) => Math.abs(avgGap - c.days) <= c.tolerance);
    if (!cadence) continue;

    // Amounts must be broadly stable — a shop you visit monthly for varying
    // amounts is a habit, not a subscription.
    const amounts = list.map((t) => t.amount);
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const spread = Math.max(...amounts) - Math.min(...amounts);
    const variance = avgAmount > 0 ? spread / avgAmount : 1;
    if (variance > 0.35 && !list[0].knownRecurring) continue;

    const last = list[list.length - 1];
    const nextDue = last.ts + cadence.days * DAY;

    // Confidence rises with sample size and falls with interval jitter.
    const jitter = gaps.reduce((a, g) => a + Math.abs(g - avgGap), 0) / gaps.length;
    const confidence = Math.max(0.4, Math.min(0.99,
      0.55 + Math.min(list.length, 6) * 0.06 - (jitter / cadence.days) * 0.5 - variance * 0.2));

    found.push({
      merchant,
      category: last.category,
      cadence: cadence.name,
      cadenceDays: cadence.days,
      avgAmount: Math.round(avgAmount * 100) / 100,
      lastAmount: last.amount,
      lastPaid: last.ts,
      nextDue,
      occurrences: list.length,
      totalPaid: amounts.reduce((a, b) => a + b, 0),
      confidence,
      isCommitment: COMMITMENT_CATEGORIES.has(last.category),
      isSubscription: (!!last.knownRecurring || cadence.name === 'monthly')
        && !COMMITMENT_CATEGORIES.has(last.category),
      txnIds: list.map((t) => t.id),
    });
  }

  return found.sort((a, b) => a.nextDue - b.nextDue);
}

/** Recurring items falling due inside the next `days` window. */
export function upcomingPayments(recurring, days = 30, now = Date.now()) {
  const horizon = now + days * DAY;
  return recurring
    .filter((r) => r.nextDue >= now - 2 * DAY && r.nextDue <= horizon && r.confidence > 0.5)
    .sort((a, b) => a.nextDue - b.nextDue);
}

// --- Forecasting ------------------------------------------------------------

/**
 * Project month-end spend from (a) the run rate so far this month and (b) known
 * recurring payments still to land. Blending the two beats either alone: pure
 * run-rate misses a ₹40k EMI on the 28th, pure recurring misses daily spend.
 */
export function forecastMonth(txns, recurring, now = Date.now()) {
  const monthStart = startOfMonth(now);
  const totalDays = daysInMonth(now);
  const dayOfMonth = new Date(now).getDate();

  const thisMonth = txns.filter((t) => t.ts >= monthStart && t.ts <= now && isSpend(t) && !t.duplicateOf);
  const spentSoFar = sum(thisMonth);

  // Recurring already paid this month must not be double-counted.
  const paidMerchants = new Set(thisMonth.map((t) => t.merchant));
  const stillDue = recurring.filter((r) =>
    r.confidence > 0.5 &&
    r.nextDue > now &&
    r.nextDue <= monthStart + totalDays * DAY &&
    !paidMerchants.has(r.merchant));
  const committed = sum(stillDue, (r) => r.avgAmount);

  // Discretionary run rate excludes recurring, which is already counted above.
  const recurringMerchants = new Set(recurring.map((r) => r.merchant));
  const discretionary = sum(thisMonth.filter((t) => !recurringMerchants.has(t.merchant)));
  const dailyRate = dayOfMonth > 0 ? discretionary / dayOfMonth : 0;
  const projectedDiscretionary = dailyRate * (totalDays - dayOfMonth);

  const projected = spentSoFar + committed + projectedDiscretionary;

  // Historical months give us a confidence band.
  const history = monthlyTotals(txns);
  const past = history.filter((m) => m.key !== monthKey(now)).slice(-6);
  const avgPast = past.length ? sum(past, (m) => m.spend) / past.length : projected;

  return {
    spentSoFar,
    committed,
    projectedDiscretionary,
    projected: Math.round(projected),
    dailyRate: Math.round(dailyRate),
    daysLeft: totalDays - dayOfMonth,
    avgPastMonths: Math.round(avgPast),
    vsAverage: avgPast > 0 ? (projected - avgPast) / avgPast : 0,
    stillDue,
  };
}

/** Per-month spend / income / net, oldest first. */
export function monthlyTotals(txns) {
  const map = new Map();
  for (const t of txns) {
    if (t.duplicateOf || t.excluded) continue;
    const key = monthKey(t.ts);
    if (!map.has(key)) map.set(key, { key, spend: 0, income: 0, count: 0, ts: startOfMonth(t.ts) });
    const bucket = map.get(key);
    if (isSpend(t)) { bucket.spend += t.amount; bucket.count++; }
    else if (t.direction === 'credit' && !t.flags?.failed) bucket.income += t.amount;
  }
  return [...map.values()]
    .map((m) => ({ ...m, net: m.income - m.spend }))
    .sort((a, b) => a.ts - b.ts);
}

/** Per-day spend totals across a window, for the trend chart and heatmap. */
export function dailyTotals(txns, days = 90, now = Date.now()) {
  const start = startOfDay(now) - (days - 1) * DAY;
  const map = new Map();
  for (let d = start; d <= startOfDay(now); d += DAY) map.set(d, 0);
  for (const t of txns) {
    if (!isSpend(t) || t.duplicateOf) continue;
    const key = startOfDay(t.ts);
    if (map.has(key)) map.set(key, map.get(key) + t.amount);
  }
  return [...map.entries()].map(([ts, amount]) => ({ ts, amount }));
}

/** Category breakdown for a set of transactions, largest first. */
export function categoryTotals(txns) {
  const map = new Map();
  for (const t of txns) {
    if (!isSpend(t) || t.duplicateOf) continue;
    map.set(t.category, (map.get(t.category) || 0) + t.amount);
  }
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  return [...map.entries()]
    .map(([category, amount]) => ({ category, amount, share: total ? amount / total : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

// --- Anomaly detection ------------------------------------------------------

/**
 * Flag transactions that are large relative to that merchant's own history,
 * using a median/MAD score so a single past outlier can't hide the next one.
 */
export function detectAnomalies(txns, { minAmount = 500 } = {}) {
  const byMerchant = new Map();
  for (const t of txns) {
    if (!isSpend(t) || t.duplicateOf) continue;
    if (!byMerchant.has(t.merchant)) byMerchant.set(t.merchant, []);
    byMerchant.get(t.merchant).push(t);
  }

  const anomalies = [];
  const allSpend = txns.filter((t) => isSpend(t) && !t.duplicateOf).map((t) => t.amount).sort((a, b) => a - b);
  const globalP95 = allSpend.length ? allSpend[Math.floor(allSpend.length * 0.95)] : Infinity;

  for (const [merchant, list] of byMerchant) {
    if (list.length < 4) continue;
    const amounts = list.map((t) => t.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const deviations = amounts.map((a) => Math.abs(a - median)).sort((a, b) => a - b);
    const mad = deviations[Math.floor(deviations.length / 2)] || median * 0.2;

    for (const t of list) {
      const score = mad > 0 ? (t.amount - median) / (1.4826 * mad) : 0;
      if (score > 3.5 && t.amount > minAmount) {
        anomalies.push({ txn: t, merchant, score, median, reason: `${Math.round(t.amount / median)}× your usual at ${merchant}` });
      }
    }
  }

  // Anything in the top 5% of all spend is worth surfacing even for new merchants.
  for (const t of txns) {
    if (!isSpend(t) || t.duplicateOf) continue;
    if (t.amount >= globalP95 && t.amount > minAmount && !anomalies.some((a) => a.txn.id === t.id)) {
      anomalies.push({ txn: t, merchant: t.merchant, score: 3, median: globalP95, reason: 'Among your largest transactions' });
    }
  }

  return anomalies.sort((a, b) => b.txn.ts - a.txn.ts);
}

// --- Budgets ----------------------------------------------------------------

/**
 * Generate a budget per category from trailing months. Uses a trimmed mean
 * (drops the single highest month) so one holiday doesn't permanently inflate
 * the target, then adds 10% headroom so budgets are achievable rather than
 * aspirational — a budget you always breach stops being information.
 */
export function suggestBudgets(txns, { months = 3, now = Date.now() } = {}) {
  const cutoff = startOfMonth(now) - months * 31 * DAY;
  const recent = txns.filter((t) => t.ts >= cutoff && isSpend(t) && !t.duplicateOf);

  const byCategoryMonth = new Map();
  for (const t of recent) {
    const key = `${t.category}|${monthKey(t.ts)}`;
    byCategoryMonth.set(key, (byCategoryMonth.get(key) || 0) + t.amount);
  }

  const perCategory = new Map();
  for (const [key, amount] of byCategoryMonth) {
    const category = key.split('|')[0];
    if (!perCategory.has(category)) perCategory.set(category, []);
    perCategory.get(category).push(amount);
  }

  const budgets = {};
  for (const [category, monthlyAmounts] of perCategory) {
    if (monthlyAmounts.length === 0) continue;
    const sorted = [...monthlyAmounts].sort((a, b) => a - b);
    const trimmed = sorted.length > 2 ? sorted.slice(0, -1) : sorted;
    const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    // Round to the nearest ₹100 — precise budgets read as false precision.
    budgets[category] = Math.max(100, Math.round((mean * 1.1) / 100) * 100);
  }
  return budgets;
}

// --- Financial health score -------------------------------------------------

/**
 * A 0–100 score from four weighted components. Deliberately simple and
 * explainable: the user should be able to see exactly why it moved.
 */
export function healthScore(txns, recurring, now = Date.now()) {
  const months = monthlyTotals(txns).slice(-6);
  const components = [];

  const income = sum(months, (m) => m.income);
  const spend = sum(months, (m) => m.spend);
  const savingsRate = income > 0 ? (income - spend) / income : 0;
  components.push({
    label: 'Savings rate',
    weight: 0.35,
    score: Math.max(0, Math.min(1, savingsRate / 0.3)),
    detail: `${Math.round(savingsRate * 100)}% of income kept`,
  });

  const subs = recurring.filter((r) => r.isSubscription);
  const monthlySubs = sum(subs, (r) => (r.cadence === 'monthly' ? r.avgAmount : r.avgAmount / (r.cadenceDays / 30.4)));
  const subsRatio = income > 0 ? monthlySubs / (income / Math.max(months.length, 1)) : 0;
  components.push({
    label: 'Subscription load',
    weight: 0.15,
    score: Math.max(0, Math.min(1, 1 - subsRatio / 0.15)),
    detail: `${formatINR(monthlySubs)}/mo across ${subs.length} subscriptions`,
  });

  const emiSpend = sum(txns.filter((t) => (t.category === 'EMI' || t.category === 'Loan') && isSpend(t)));
  const emiRatio = income > 0 ? emiSpend / income : 0;
  components.push({
    label: 'Debt burden',
    weight: 0.25,
    score: Math.max(0, Math.min(1, 1 - emiRatio / 0.4)),
    detail: emiRatio > 0 ? `${Math.round(emiRatio * 100)}% of income to EMIs` : 'No EMIs detected',
  });

  // Volatility: steady spending is easier to plan around than spiky spending.
  const spends = months.map((m) => m.spend).filter((s) => s > 0);
  const avg = spends.length ? spends.reduce((a, b) => a + b, 0) / spends.length : 0;
  const sd = spends.length > 1
    ? Math.sqrt(spends.reduce((a, s) => a + (s - avg) ** 2, 0) / spends.length)
    : 0;
  const cv = avg > 0 ? sd / avg : 0;
  components.push({
    label: 'Spending stability',
    weight: 0.25,
    score: Math.max(0, Math.min(1, 1 - cv / 0.5)),
    detail: cv < 0.2 ? 'Very consistent month to month' : cv < 0.4 ? 'Moderately variable' : 'Highly variable',
  });

  const score = Math.round(components.reduce((a, c) => a + c.score * c.weight, 0) * 100);
  const grade = score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 50 ? 'Fair' : score >= 35 ? 'Needs work' : 'At risk';

  return { score, grade, components, savingsRate, monthlySubs };
}

// --- Insight generation -----------------------------------------------------

/**
 * Turn the analytics above into ranked, plain-language observations. Each
 * insight carries a severity so the UI can order and colour them.
 */
export function generateInsights(state, now = Date.now()) {
  const { txns, recurring, forecast, budgets, anomalies, health } = state;
  const insights = [];
  const push = (severity, title, body, meta = {}) => insights.push({ severity, title, body, ...meta });

  // Month-over-month movement.
  const months = monthlyTotals(txns);
  const current = months[months.length - 1];
  const previous = months[months.length - 2];
  if (current && previous && previous.spend > 0) {
    const delta = (current.spend - previous.spend) / previous.spend;
    if (Math.abs(delta) > 0.15) {
      const up = delta > 0;
      push(up ? 'warn' : 'good',
        `Spending ${up ? 'up' : 'down'} ${Math.abs(Math.round(delta * 100))}% this month`,
        `${formatINR(current.spend)} so far vs ${formatINR(previous.spend)} last month.`);
    }
  }

  // Which category drove the change.
  if (current && previous) {
    const curCats = categoryTotals(txns.filter((t) => monthKey(t.ts) === current.key));
    const prevCats = new Map(categoryTotals(txns.filter((t) => monthKey(t.ts) === previous.key)).map((c) => [c.category, c.amount]));
    let biggest = null;
    for (const c of curCats) {
      const diff = c.amount - (prevCats.get(c.category) || 0);
      if (!biggest || diff > biggest.diff) biggest = { category: c.category, diff, amount: c.amount };
    }
    if (biggest && biggest.diff > 1000) {
      push('info', `${biggest.category} is driving the increase`,
        `Up ${formatINR(biggest.diff)} versus last month, now at ${formatINR(biggest.amount)}.`);
    }
  }

  // Forecast vs history.
  if (forecast && forecast.vsAverage > 0.2 && forecast.avgPastMonths > 0) {
    push('warn', `On track to overspend by ${formatINR(forecast.projected - forecast.avgPastMonths)}`,
      `Projected ${formatINR(forecast.projected)} this month against a ${formatINR(forecast.avgPastMonths)} average. ${formatINR(forecast.dailyRate)}/day for ${forecast.daysLeft} more days.`);
  }

  // Subscription drag.
  const subs = (recurring || []).filter((r) => r.isSubscription);
  if (subs.length >= 3) {
    const monthly = sum(subs, (r) => (r.cadence === 'monthly' ? r.avgAmount : r.avgAmount / (r.cadenceDays / 30.4)));
    push('info', `${subs.length} subscriptions costing ${formatINR(monthly)}/month`,
      `That is ${formatINR(monthly * 12)} a year. Largest: ${subs.slice().sort((a, b) => b.avgAmount - a.avgAmount)[0].merchant}.`);
  }

  // Dormant subscriptions — paying for something with no other engagement signal.
  for (const r of subs) {
    const sinceLast = (now - r.lastPaid) / DAY;
    if (r.cadence === 'monthly' && sinceLast > 45) {
      push('warn', `${r.merchant} may have lapsed or changed`,
        `Last charge was ${Math.round(sinceLast)} days ago at ${formatINR(r.lastAmount)}, but it billed monthly before.`);
    }
  }

  // Budget breaches.
  if (budgets) {
    const monthStart = startOfMonth(now);
    const thisMonth = txns.filter((t) => t.ts >= monthStart && isSpend(t) && !t.duplicateOf);
    const spentByCategory = new Map();
    for (const t of thisMonth) spentByCategory.set(t.category, (spentByCategory.get(t.category) || 0) + t.amount);
    for (const [category, limit] of Object.entries(budgets)) {
      const spent = spentByCategory.get(category) || 0;
      if (spent > limit) {
        push('bad', `${category} budget exceeded`, `${formatINR(spent)} against a ${formatINR(limit)} budget.`, { category });
      } else if (spent > limit * 0.85) {
        push('warn', `${category} budget almost spent`, `${formatINR(spent)} of ${formatINR(limit)} used.`, { category });
      }
    }
  }

  // Duplicates.
  const dupes = txns.filter((t) => t.duplicateOf);
  if (dupes.length) {
    push('bad', `${dupes.length} possible duplicate charge${dupes.length > 1 ? 's' : ''}`,
      `Totalling ${formatINR(sum(dupes))}. Review them before they go unchallenged.`);
  }

  // Anomalies.
  for (const a of (anomalies || []).slice(0, 3)) {
    push('warn', `Unusual: ${formatINR(a.txn.amount)} at ${a.merchant}`, a.reason, { txnId: a.txn.id });
  }

  // Health.
  if (health && health.score < 50) {
    const weakest = [...health.components].sort((a, b) => a.score - b.score)[0];
    push('warn', `Financial health is ${health.grade.toLowerCase()} (${health.score}/100)`,
      `Weakest area: ${weakest.label.toLowerCase()} — ${weakest.detail}.`);
  }

  const RANK = { bad: 0, warn: 1, info: 2, good: 3 };
  return insights.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

// --- Affordability ----------------------------------------------------------

/**
 * Answer "can I afford X?" — projected month-end surplus against a proposed
 * amount, accounting for committed recurring payments.
 */
export function canAfford(amount, state, now = Date.now()) {
  const { txns, forecast, balance } = state;
  const months = monthlyTotals(txns);
  const recentIncome = months.slice(-3).filter((m) => m.income > 0);
  const avgIncome = recentIncome.length ? sum(recentIncome, (m) => m.income) / recentIncome.length : 0;

  const available = (balance || 0) - forecast.committed - forecast.projectedDiscretionary;
  const verdict = available >= amount ? 'yes' : available + avgIncome >= amount ? 'tight' : 'no';

  return {
    verdict,
    amount,
    available: Math.round(available),
    balance: balance || 0,
    committed: forecast.committed,
    projectedRemaining: forecast.projectedDiscretionary,
    avgIncome: Math.round(avgIncome),
    monthsToSave: avgIncome > 0 ? Math.ceil(amount / Math.max(avgIncome * 0.2, 1)) : null,
  };
}
