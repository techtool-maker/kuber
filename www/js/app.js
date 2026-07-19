/**
 * Kuber — application shell.
 *
 * Wires the engine to the DOM: view rendering, modals, import/export and
 * settings. Deliberately framework-free so the whole app is one folder of
 * static files that runs offline from `file://` or any static host.
 */

import * as store from './core/store.js';
import { CATEGORIES, CATEGORY_META } from './engine/categorizer.js';
import { formatINR, sum, isSpend, monthKey } from './engine/intelligence.js';
import * as llm from './engine/llm.js';
import { generateDemoSms } from './data/samples.js';
import { donutChart, monthlyBars, trendChart, heatmap, scoreRing } from './ui/charts.js';
import { parseQuery, applyFilters, answer, SUGGESTIONS } from './ui/assistant.js';

const DAY = 86_400_000;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Minimal markdown: **bold** and newlines. Keeps assistant replies readable. */
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

const icon = (category) => CATEGORY_META[category]?.icon || '📦';

// ---------------------------------------------------------------- app state

let state = null;
let currentView = 'home';
const ui = {
  search: '',
  filter: 'all',
  timelineLimit: 60,
  chat: [],
  busy: false,
};

// ------------------------------------------------------------ platform notes

// `?ios=1` forces the Safari-tab banner and `?ios=standalone` the home-screen
// one, so both can be checked from a desktop browser without an iPhone.
const IOS_OVERRIDE = new URLSearchParams(location.search).get('ios');

const isIOS = IOS_OVERRIDE !== null
  || /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS 13+ lies
const isStandalone = IOS_OVERRIDE === 'standalone'
  || window.navigator.standalone === true
  || window.matchMedia('(display-mode: standalone)').matches;

/**
 * Ask the browser to make storage persistent.
 *
 * Chrome honours this and stops evicting under pressure. Safari does not
 * implement it meaningfully, which is exactly why the iOS banner below exists
 * as well — this call is a best effort, not a guarantee.
 */
async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* nothing to do if it is unsupported */ }
}

const DAY_MS = 86_400_000;

/**
 * iOS-specific durability warning.
 *
 * Safari's Intelligent Tracking Prevention clears script-writable storage —
 * localStorage included — after roughly seven days without interaction with
 * the site. Home-screen web apps are treated more favourably, but eviction
 * under storage pressure is still possible and gives no warning.
 *
 * For an app holding months of financial history that is a real data-loss
 * risk, so it gets stated plainly rather than buried in a settings page.
 */
function platformNotice() {
  const db = store.getDb();
  if (!isIOS || db.settings.dismissedIosTip) return null;

  const el = document.createElement('div');
  el.className = 'notice warn mb';

  if (!isStandalone) {
    el.innerHTML = `
      <strong>On iPhone, add this to your Home Screen.</strong>
      Tap Share <span aria-hidden="true">→</span> <em>Add to Home Screen</em>.
      Safari clears saved data for ordinary tabs after about a week of not visiting,
      which would wipe your transaction history. Home-screen apps are kept far longer.
      <div class="btn-row mt">
        <button class="btn sm ghost" data-act="backup">Export a backup now</button>
        <button class="btn sm ghost" data-act="dismiss">Got it</button>
      </div>`;
  } else {
    const last = db.meta.lastBackup;
    const age = last ? Math.floor((Date.now() - last) / DAY_MS) : null;
    if (last && age < 14) return null;
    el.innerHTML = `
      <strong>${last ? `Last backup was ${age} days ago.` : 'You have never exported a backup.'}</strong>
      iOS can still clear app storage when the device runs low on space, and it does so
      without warning. Exporting to Files takes a second and is the only real safety net.
      <div class="btn-row mt">
        <button class="btn sm primary" data-act="backup">Export backup</button>
        <button class="btn sm ghost" data-act="dismiss">Not now</button>
      </div>`;
  }

  el.querySelector('[data-act="backup"]').onclick = () => { doBackup(); refresh({ force: true }); };
  el.querySelector('[data-act="dismiss"]').onclick = () => {
    if (isStandalone) { store.updateProfile({}); db.meta.lastBackup = Date.now() - 7 * DAY_MS; store.commit(); }
    else store.updateSettings({ dismissedIosTip: true });
    refresh({ force: true });
  };
  return el;
}

// ---------------------------------------------------------------- utilities

function toast(message, ms = 2600) {
  const root = $('#toastRoot');
  root.innerHTML = `<div class="toast">${esc(message)}</div>`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { root.innerHTML = ''; }, ms);
}

function openModal(title, bodyHtml, { onMount } = {}) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" data-close>
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="grabber"></div>
        <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close>✕</button></div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    </div>`;
  root.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', (e) => { if (e.target === el) closeModal(); });
  });
  document.addEventListener('keydown', escClose);
  onMount?.($('.modal-body', root));
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }

function relativeDay(ts) {
  const today = new Date().setHours(0, 0, 0, 0);
  const day = new Date(ts).setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return new Date(ts).toLocaleDateString('en-IN', { weekday: 'long' });
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: diff > 300 ? 'numeric' : undefined });
}

// ---------------------------------------------------------------- rendering

function refresh({ force = false } = {}) {
  if (force) store.invalidate();
  state = store.derive({ force });

  const badge = $('#reviewBadge');
  const count = state.needsReview.length + state.duplicates.length;
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);

  const render = { home: renderHome, timeline: renderTimeline, insights: renderInsights, assistant: renderAssistant, plan: renderPlan }[currentView];
  try {
    render?.();
  } catch (err) {
    // A throw partway through a render leaves a half-drawn view that looks like
    // missing data rather than a bug. Make it loud instead.
    console.error(`Render failed for "${currentView}"`, err);
    toast(`Something failed while drawing this screen: ${err.message}`, 6000);
  }
}

function switchView(view) {
  currentView = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  window.scrollTo({ top: 0, behavior: 'instant' });
  refresh();
}

// ---- Home ------------------------------------------------------------------

function renderHome() {
  const root = $('#homeContent');
  const notice = platformNotice();

  if (!state.txns.length) {
    root.innerHTML = `
      <div class="empty">
        <div class="ico">₹</div>
        <h3>Nothing to show yet</h3>
        <p>Kuber reads your bank SMS and works everything out by itself — merchants, categories, subscriptions, forecasts. Import once to begin.</p>
        <div class="btn-row" style="justify-content:center">
          <button class="btn primary" id="emptyImport">Import my SMS</button>
          <button class="btn ghost" id="emptyDemo">Load demo data</button>
        </div>
      </div>`;
    $('#emptyImport').onclick = showImport;
    $('#emptyDemo').onclick = loadDemo;
    if (notice) root.prepend(notice);
    return;
  }

  const f = state.forecast;
  const budgetLeft = state.totalBudget - state.monthSpend;
  const monthName = new Date(state.now).toLocaleDateString('en-IN', { month: 'long' });

  root.innerHTML = `
    <div class="hero">
      <div class="label">Total balance</div>
      <div class="value">${formatINR(state.balance)}</div>
      <div class="row">
        <div><div class="k">Spent today</div><div class="v">${formatINR(state.todaySpend)}</div></div>
        <div><div class="k">${esc(monthName)} spend</div><div class="v">${formatINR(state.monthSpend)}</div></div>
        <div><div class="k">Projected</div><div class="v">${formatINR(f.projected)}</div></div>
      </div>
    </div>

    <div class="grid grid-2 grid-lg-4" style="margin-top:12px">
      <div class="stat income">
        <div class="stat-label">Income</div>
        <div class="stat-value">${formatINR(state.monthIncome, { compact: true })}</div>
        <div class="stat-note">this month</div>
      </div>
      <div class="stat spend">
        <div class="stat-label">Spend</div>
        <div class="stat-value">${formatINR(state.monthSpend, { compact: true })}</div>
        <div class="stat-note">${f.daysLeft} days left</div>
      </div>
      <div class="stat">
        <div class="stat-label">Budget left</div>
        <div class="stat-value" style="color:${budgetLeft < 0 ? 'var(--spend)' : 'var(--income)'}">${state.totalBudget ? formatINR(budgetLeft, { compact: true }) : '—'}</div>
        <div class="stat-note">${state.totalBudget ? `of ${formatINR(state.totalBudget, { compact: true })}` : 'not set'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Health</div>
        <div class="stat-value">${state.health.score}<span style="font-size:.8rem;color:var(--text-3)">/100</span></div>
        <div class="stat-note">${esc(state.health.grade)}</div>
      </div>
    </div>

    ${state.insights.length ? `
    <div class="card" style="margin-top:12px">
      <div class="card-head"><h3>What needs attention</h3><button class="link" data-goto="insights">See all</button></div>
      <div id="homeInsights"></div>
    </div>` : ''}

    ${state.upcoming.length ? `
    <div class="card">
      <div class="card-head"><h3>Coming up</h3><span class="badge">${state.upcoming.length}</span></div>
      <div class="list" id="upcomingList"></div>
      <div class="divider"></div>
      <div class="kv"><span class="k">Total due in 30 days</span><span class="v">${formatINR(sum(state.upcoming, (r) => r.avgAmount))}</span></div>
    </div>` : ''}

    <div class="card">
      <div class="card-head"><h3>${esc(monthName)} by category</h3></div>
      <div id="donutHolder"></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Daily spending</h3></div>
      <div id="trendHolder"></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Recent activity</h3><button class="link" data-goto="timeline">See all</button></div>
      <div class="list" id="recentList"></div>
    </div>`;

  if (state.insights.length) {
    $('#homeInsights').append(...state.insights.slice(0, 3).map(insightEl));
  }
  if (state.upcoming.length) {
    $('#upcomingList').innerHTML = state.upcoming.slice(0, 5).map((r) => {
      const days = Math.round((r.nextDue - state.now) / DAY);
      const when = days <= 0 ? 'Due now' : days === 1 ? 'Tomorrow' : `In ${days} days`;
      return `
        <div class="row-item">
          <div class="avatar">${icon(r.category)}</div>
          <div class="body">
            <div class="title">${esc(r.merchant)}</div>
            <div class="meta">${when} · ${esc(r.cadence)} · ${Math.round(r.confidence * 100)}% confident</div>
          </div>
          <div class="amount debit">${formatINR(r.avgAmount)}</div>
        </div>`;
    }).join('');
  }

  $('#donutHolder').append(donutChart(state.categories));
  $('#trendHolder').append(trendChart(state.daily));
  $('#recentList').append(...state.active.slice(0, 8).map(txnRow));

  if (notice) root.prepend(notice);
  $$('[data-goto]', root).forEach((b) => { b.onclick = () => switchView(b.dataset.goto); });
}

function insightEl(insight) {
  const el = document.createElement('div');
  el.className = `insight ${insight.severity}`;
  el.innerHTML = `
    <div class="body">
      <div class="t">${esc(insight.title)}</div>
      <div class="d">${esc(insight.body)}</div>
    </div>
    <button class="dismiss" title="Dismiss">✕</button>`;
  $('.dismiss', el).onclick = (e) => {
    e.stopPropagation();
    store.dismissInsight(insight.title);
    refresh({ force: true });
  };
  return el;
}

function txnRow(t) {
  const el = document.createElement('div');
  el.className = 'row-item';
  const time = new Date(t.ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const tags = [
    t.duplicateOf ? '<span class="badge bad">duplicate</span>' : '',
    t.needsReview ? '<span class="badge warn">review</span>' : '',
    t.flags?.refund ? '<span class="badge good">refund</span>' : '',
    t.excluded ? '<span class="badge">excluded</span>' : '',
  ].join('');

  el.innerHTML = `
    <div class="avatar">${icon(t.category)}</div>
    <div class="body">
      <div class="title">${esc(t.merchant)} ${tags}</div>
      <div class="meta">${esc(t.category)} · ${time}${t.mode !== 'other' ? ` · ${esc(t.mode.toUpperCase())}` : ''}${t.bank ? ` · ${esc(t.bank)}` : ''}</div>
    </div>
    <div class="amount ${t.direction}">${t.direction === 'credit' ? '+' : ''}${formatINR(t.amount)}</div>`;
  el.onclick = () => showTxnDetail(t);
  return el;
}

// ---- Timeline --------------------------------------------------------------

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'review', label: 'Needs review' },
  { id: 'duplicates', label: 'Duplicates' },
  { id: 'credit', label: 'Income' },
  { id: 'large', label: 'Large' },
  { id: 'upi', label: 'UPI' },
  { id: 'card', label: 'Card' },
];

function renderTimeline() {
  $('#filterChips').innerHTML = FILTERS
    .map((f) => `<button class="chip ${ui.filter === f.id ? 'active' : ''}" data-filter="${f.id}">${esc(f.label)}</button>`)
    .join('');
  $$('#filterChips .chip').forEach((c) => {
    c.onclick = () => { ui.filter = c.dataset.filter; ui.timelineLimit = 60; renderTimeline(); };
  });

  let list = state.txns;

  if (ui.search.trim()) {
    list = applyFilters(list, { ...parseQuery(ui.search, state.now), includeDuplicates: true });
  }

  switch (ui.filter) {
    case 'review':     list = list.filter((t) => t.needsReview); break;
    case 'duplicates': list = list.filter((t) => t.duplicateOf); break;
    case 'credit':     list = list.filter((t) => t.direction === 'credit'); break;
    case 'large':      list = list.filter((t) => t.amount >= 2000); break;
    case 'upi':        list = list.filter((t) => t.mode === 'upi'); break;
    case 'card':       list = list.filter((t) => t.mode === 'card'); break;
    default:           list = list.filter((t) => !t.duplicateOf || ui.search.trim());
  }

  const total = sum(list.filter(isSpend));
  $('#timelineCount').textContent = `${list.length} transactions · ${formatINR(total)}`;

  const container = $('#timelineList');
  container.innerHTML = '';

  if (!list.length) {
    container.innerHTML = '<div class="empty"><div class="ico">🔍</div><h3>Nothing matched</h3><p>Try a different search, or clear the filter.</p></div>';
    return;
  }

  // Group by day.
  const shown = list.slice(0, ui.timelineLimit);
  const groups = new Map();
  for (const t of shown) {
    const key = new Date(t.ts).setHours(0, 0, 0, 0);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  for (const [dayTs, items] of groups) {
    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `<span>${esc(relativeDay(dayTs))}</span><span class="total">${formatINR(sum(items.filter(isSpend)))}</span>`;
    container.append(header);

    const listEl = document.createElement('div');
    listEl.className = 'list';
    listEl.append(...items.map(txnRow));
    container.append(listEl);
  }

  if (list.length > ui.timelineLimit) {
    const more = document.createElement('button');
    more.className = 'btn ghost block mt';
    more.textContent = `Load ${Math.min(60, list.length - ui.timelineLimit)} more`;
    more.onclick = () => { ui.timelineLimit += 60; renderTimeline(); };
    container.append(more);
  }
}

// ---- Transaction detail ----------------------------------------------------

function showTxnDetail(t) {
  const rows = [
    ['Amount', `${t.direction === 'credit' ? '+' : '−'}${formatINR(t.amount)}`],
    ['Merchant', t.merchant],
    ['Category', `${icon(t.category)} ${t.category}`],
    ['Date', new Date(t.ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })],
    ['Mode', t.mode?.toUpperCase()],
    ['Bank', t.bank],
    ['Account', t.accountLast4 ? `••${t.accountLast4}` : null],
    ['Card', t.cardLast4 ? `••${t.cardLast4}` : null],
    ['UPI ID', t.vpa],
    ['Reference', t.refId],
    ['Balance after', t.balance != null ? formatINR(t.balance) : null],
    ['Parsed via', `${t.categorySource} · ${Math.round((t.confidence || 0) * 100)}% confident`],
  ].filter(([, v]) => v);

  openModal(t.merchant, `
    <div>${rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>

    <div class="field mt">
      <label for="catSelect">Category — corrections are remembered for this merchant</label>
      <select id="catSelect">
        ${CATEGORIES.map((c) => `<option value="${esc(c)}" ${c === t.category ? 'selected' : ''}>${icon(c)} ${esc(c)}</option>`).join('')}
      </select>
    </div>

    <div class="field">
      <label for="merchantInput">Merchant name</label>
      <input type="text" id="merchantInput" value="${esc(t.merchant)}">
    </div>

    <div class="btn-row mt">
      <button class="btn primary" id="saveTxn">Save</button>
      <button class="btn ghost" id="toggleExclude">${t.excluded ? 'Include in totals' : 'Exclude from totals'}</button>
      <button class="btn danger" id="deleteTxn">Delete</button>
    </div>

    ${t.raw ? `<div class="mt"><div class="tiny mb">Original message</div><div class="raw-sms">${esc(t.raw)}</div></div>` : ''}
  `, {
    onMount(body) {
      $('#saveTxn', body).onclick = () => {
        const category = $('#catSelect', body).value;
        const merchant = $('#merchantInput', body).value.trim();
        if (merchant && merchant !== t.merchant) store.renameMerchant(t.id, merchant);
        if (category !== t.category) store.recategorise(t.id, category);
        closeModal();
        refresh({ force: true });
        toast('Saved — future transactions will follow this');
      };
      $('#toggleExclude', body).onclick = () => {
        store.setExcluded(t.id, !t.excluded);
        closeModal(); refresh({ force: true });
        toast(t.excluded ? 'Included again' : 'Excluded from totals');
      };
      $('#deleteTxn', body).onclick = () => {
        store.deleteTxn(t.id);
        closeModal(); refresh({ force: true });
        toast('Transaction deleted');
      };
    },
  });
}

// ---- Insights --------------------------------------------------------------

function renderInsights() {
  const root = $('#insightsContent');
  const h = state.health;

  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Financial health</h3></div>
      <div class="score-ring">
        <div id="ringHolder"></div>
        <div style="flex:1">
          <div style="font-weight:650;font-size:1.05rem">${esc(h.grade)}</div>
          <div class="muted">${Math.round(h.savingsRate * 100)}% of income kept over the last 6 months.</div>
        </div>
      </div>
      <div class="divider"></div>
      ${h.components.map((c) => `
        <div style="margin-bottom:11px">
          <div style="display:flex;justify-content:space-between;font-size:.84rem;margin-bottom:4px">
            <span>${esc(c.label)}</span><strong>${Math.round(c.score * 100)}</strong>
          </div>
          <div class="bar"><span style="width:${Math.round(c.score * 100)}%" class="${c.score < 0.4 ? 'over' : c.score < 0.7 ? 'near' : ''}"></span></div>
          <div class="tiny" style="margin-top:3px">${esc(c.detail)}</div>
        </div>`).join('')}
    </div>

    ${state.insights.length ? `<div class="card"><div class="card-head"><h3>Observations</h3></div><div id="allInsights"></div></div>` : ''}

    ${state.needsReview.length ? `
    <div class="card">
      <div class="card-head"><h3>Needs your review</h3><span class="badge warn">${state.needsReview.length}</span></div>
      <p class="muted mb">These were parsed with low confidence. Correcting one teaches Kuber the merchant permanently.</p>
      <div class="list" id="reviewList"></div>
      ${llm.getConfig() ? `<button class="btn primary block mt" id="btnEnrich">Resolve with AI (${state.needsReview.length})</button>` : `<p class="tiny mt">Add an AI key in Settings to resolve these automatically.</p>`}
    </div>` : ''}

    ${state.duplicates.length ? `
    <div class="card">
      <div class="card-head"><h3>Possible duplicates</h3><span class="badge bad">${state.duplicates.length}</span></div>
      <p class="muted mb">Same amount and merchant within minutes. Often two banks reporting one payment — but sometimes a real double charge.</p>
      <div class="list" id="dupeList"></div>
    </div>` : ''}

    <div class="card">
      <div class="card-head"><h3>Subscriptions</h3><span class="badge">${state.subscriptions.length}</span></div>
      <p class="muted mb">Recurring and discretionary — these are the ones you could actually cancel.</p>
      ${state.subscriptions.length ? `<div class="list" id="subsList"></div>` : '<p class="muted">None detected yet — this needs two or three billing cycles of history.</p>'}
    </div>

    ${state.commitments.length ? `
    <div class="card">
      <div class="card-head"><h3>Fixed commitments</h3><span class="badge">${state.commitments.length}</span></div>
      <p class="muted mb">Rent, EMIs, insurance and investments. Tracked and forecast, but not treated as things to cut.</p>
      <div class="list" id="commitList"></div>
      <div class="divider"></div>
      <div class="kv"><span class="k">Monthly commitment</span><span class="v">${formatINR(sum(state.commitments, (r) => (r.cadence === 'monthly' ? r.avgAmount : r.avgAmount / (r.cadenceDays / 30.4))))}</span></div>
    </div>` : ''}

    <div class="card">
      <div class="card-head"><h3>Income vs spending</h3></div>
      <div id="barsHolder"></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Spending calendar</h3></div>
      <div id="heatHolder"></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Reports</h3></div>
      <div class="btn-row">
        <button class="btn ghost sm" data-export="csv">Export CSV</button>
        <button class="btn ghost sm" data-export="month">Monthly report</button>
        <button class="btn ghost sm" data-export="category">Category report</button>
        <button class="btn ghost sm" data-export="subs">Subscription report</button>
        <button class="btn ghost sm" data-export="tax">Tax summary</button>
      </div>
    </div>`;

  $('#ringHolder').append(scoreRing(h.score));
  if (state.insights.length) $('#allInsights').append(...state.insights.map(insightEl));
  if (state.needsReview.length) {
    $('#reviewList').append(...state.needsReview.slice(0, 25).map(txnRow));
    const btn = $('#btnEnrich');
    if (btn) btn.onclick = runEnrichment;
  }
  if (state.duplicates.length) $('#dupeList').append(...state.duplicates.slice(0, 25).map(txnRow));

  if (state.subscriptions.length) {
    $('#subsList').innerHTML = state.subscriptions
      .slice().sort((a, b) => b.avgAmount - a.avgAmount)
      .map((r) => `
        <div class="row-item">
          <div class="avatar">${icon(r.category)}</div>
          <div class="body">
            <div class="title">${esc(r.merchant)}</div>
            <div class="meta">${esc(r.cadence)} · ${r.occurrences} payments · ${formatINR(r.totalPaid)} lifetime</div>
          </div>
          <div class="amount debit">${formatINR(r.avgAmount)}</div>
        </div>`).join('');
  }

  if (state.commitments.length) {
    $('#commitList').innerHTML = state.commitments
      .slice().sort((a, b) => b.avgAmount - a.avgAmount)
      .map((r) => `
        <div class="row-item">
          <div class="avatar">${icon(r.category)}</div>
          <div class="body">
            <div class="title">${esc(r.merchant)}</div>
            <div class="meta">${esc(r.category)} · ${esc(r.cadence)} · next ${new Date(r.nextDue).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>
          </div>
          <div class="amount debit">${formatINR(r.avgAmount)}</div>
        </div>`).join('');
  }

  $('#barsHolder').append(monthlyBars(state.monthly));
  $('#heatHolder').append(heatmap(state.daily));
  $$('[data-export]', root).forEach((b) => { b.onclick = () => exportReport(b.dataset.export); });
}

async function runEnrichment() {
  const btn = $('#btnEnrich');
  if (!btn || ui.busy) return;
  ui.busy = true;
  btn.disabled = true;
  btn.textContent = 'Resolving…';

  const targets = state.needsReview.slice(0, 200);
  const result = await llm.enrich(targets, {
    onProgress: ({ done, total }) => { btn.textContent = `Resolving ${done}/${total}…`; },
  });

  ui.busy = false;
  store.commit();

  if (result.error === 'not-configured') toast('Add an API key in Settings first');
  else if (result.error) toast(`AI call failed: ${result.error}`, 5000);
  else toast(`Resolved ${result.updated} transactions (${result.cached} from cache, ${result.calls} API calls)`);

  refresh({ force: true });
}

// ---- Assistant -------------------------------------------------------------

function renderAssistant() {
  const root = $('#assistantContent');
  if (root.dataset.built === '1') { renderChat(); return; }
  root.dataset.built = '1';

  root.innerHTML = `
    <div class="notice mb">
      <strong>Rules first, AI second.</strong> Common questions are answered on-device for free. Open-ended ones use your configured model, and only ever see aggregate figures — never raw messages or account numbers.
    </div>
    <div class="suggestions" id="suggestions">
      ${SUGGESTIONS.map((s) => `<button data-q="${esc(s)}">${esc(s)}</button>`).join('')}
    </div>
    <div class="chat" id="chat"></div>
    <div class="composer">
      <input type="text" id="askInput" placeholder="Ask about your money…" autocomplete="off">
      <button id="askSend" aria-label="Send">↑</button>
    </div>`;

  $$('#suggestions button', root).forEach((b) => { b.onclick = () => submitQuestion(b.dataset.q); });
  $('#askSend', root).onclick = () => submitQuestion($('#askInput').value);
  $('#askInput', root).onkeydown = (e) => { if (e.key === 'Enter') submitQuestion(e.target.value); };
  renderChat();
}

function renderChat() {
  const chat = $('#chat');
  if (!chat) return;
  chat.innerHTML = ui.chat.map((m) => {
    if (m.role === 'user') return `<div class="msg user">${esc(m.text)}</div>`;
    const source = m.source === 'llm' ? 'Answered by AI' : m.source === 'local' ? 'Answered on-device' : '';
    return `<div class="msg bot">${md(m.text)}${source ? `<span class="src">${esc(source)}</span>` : ''}</div>`;
  }).join('');
  chat.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

async function submitQuestion(question) {
  const q = String(question || '').trim();
  if (!q || ui.busy) return;
  $('#askInput').value = '';
  ui.chat.push({ role: 'user', text: q });
  ui.chat.push({ role: 'bot', text: 'Thinking…', source: '' });
  renderChat();
  ui.busy = true;

  const result = await answer(q, state);
  ui.chat.pop();
  ui.chat.push({ role: 'bot', text: result.text, source: result.source });
  ui.busy = false;
  renderChat();

  // If the answer selected transactions, offer them on the Activity tab.
  if (result.txns?.length) {
    ui.search = q;
    ui.filter = 'all';
  }
}

// ---- Plan (budgets & goals) ------------------------------------------------

function renderPlan() {
  const root = $('#planContent');
  const monthStart = new Date(state.now).setDate(1);
  const spentByCategory = new Map();
  for (const t of state.active) {
    if (t.ts >= monthStart && isSpend(t)) spentByCategory.set(t.category, (spentByCategory.get(t.category) || 0) + t.amount);
  }

  const budgetEntries = Object.entries(state.budgets).sort((a, b) => b[1] - a[1]);

  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Budgets</h3><button class="link" id="autoBudget">Auto-generate</button></div>
      ${budgetEntries.length ? budgetEntries.map(([category, limit]) => {
        const spent = spentByCategory.get(category) || 0;
        const pct = Math.min(100, (spent / limit) * 100);
        const cls = spent > limit ? 'over' : spent > limit * 0.85 ? 'near' : '';
        return `
          <div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:.87rem;margin-bottom:5px">
              <span>${icon(category)} ${esc(category)}</span>
              <span class="num"><strong style="color:${spent > limit ? 'var(--spend)' : 'var(--text)'}">${formatINR(spent)}</strong> <span class="tiny">/ ${formatINR(limit)}</span></span>
            </div>
            <div class="bar"><span class="${cls}" style="width:${pct}%"></span></div>
          </div>`;
      }).join('') : '<p class="muted">No budgets yet. Auto-generate builds them from your last three months, trimming the highest month so one bad month does not set the bar.</p>'}
      <button class="btn ghost block mt" id="editBudgets">Edit budgets</button>
    </div>

    <div class="card">
      <div class="card-head"><h3>Goals</h3><button class="link" id="addGoal">Add goal</button></div>
      ${state.goals.length ? `<div id="goalList"></div>` : '<p class="muted">No goals yet. Add one and Kuber estimates the completion date from your actual savings rate.</p>'}
    </div>

    <div class="card">
      <div class="card-head"><h3>Month forecast</h3></div>
      <div class="kv"><span class="k">Spent so far</span><span class="v">${formatINR(state.forecast.spentSoFar)}</span></div>
      <div class="kv"><span class="k">Recurring still due</span><span class="v">${formatINR(state.forecast.committed)}</span></div>
      <div class="kv"><span class="k">Projected discretionary</span><span class="v">${formatINR(state.forecast.projectedDiscretionary)}</span></div>
      <div class="kv"><span class="k"><strong>Projected total</strong></span><span class="v"><strong>${formatINR(state.forecast.projected)}</strong></span></div>
      <div class="kv"><span class="k">6-month average</span><span class="v">${formatINR(state.forecast.avgPastMonths)}</span></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Automation rules</h3><button class="link" id="addRule">Add rule</button></div>
      <p class="muted mb">Rules run before the dictionary, so they always win. Useful for merchants only you would recognise.</p>
      <div id="ruleList"></div>
    </div>`;

  $('#autoBudget').onclick = () => {
    store.applySuggestedBudgets();
    refresh({ force: true });
    toast('Budgets generated from your history');
  };
  $('#editBudgets').onclick = showBudgetEditor;
  $('#addGoal').onclick = showGoalEditor;
  $('#addRule').onclick = showRuleEditor;

  if (state.goals.length) {
    const monthlySaving = Math.max(0, (state.monthIncome || 0) - (state.monthSpend || 0));
    $('#goalList').innerHTML = state.goals.map((g) => {
      const pct = Math.min(100, (g.saved / g.target) * 100);
      const remaining = Math.max(0, g.target - g.saved);
      const months = monthlySaving > 0 ? Math.ceil(remaining / monthlySaving) : null;
      const eta = months != null ? new Date(state.now + months * 30.4 * DAY).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : 'unknown';
      return `
        <div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;font-size:.9rem;margin-bottom:5px">
            <strong>${esc(g.name)}</strong>
            <span class="num">${formatINR(g.saved)} / ${formatINR(g.target)}</span>
          </div>
          <div class="bar"><span style="width:${pct}%"></span></div>
          <div class="tiny" style="margin-top:4px">
            ${months != null ? `At ${formatINR(monthlySaving)}/month you reach it around ${esc(eta)}.` : 'Not saving anything this month, so no completion estimate.'}
            <button class="link" data-goal="${g.id}" style="margin-left:6px">Update</button>
          </div>
        </div>`;
    }).join('');
    $$('[data-goal]', root).forEach((b) => {
      b.onclick = () => showGoalEditor(state.goals.find((g) => g.id === b.dataset.goal));
    });
  }

  const rules = store.getDb().learning.rules;
  $('#ruleList').innerHTML = rules.length
    ? rules.map((r) => `
        <div class="row-item">
          <div class="avatar">${icon(r.category)}</div>
          <div class="body"><div class="title">${esc(r.pattern)}</div><div class="meta">→ ${esc(r.category)}</div></div>
          <button class="icon-btn" data-delrule="${r.id}">✕</button>
        </div>`).join('')
    : '<p class="tiny">No custom rules yet.</p>';
  $$('[data-delrule]', root).forEach((b) => {
    b.onclick = () => { store.deleteRule(b.dataset.delrule); store.recategoriseAll(); refresh({ force: true }); };
  });
}

function showBudgetEditor() {
  const budgets = state.budgets;
  const categories = [...new Set([...Object.keys(budgets), ...state.categoriesAllTime.slice(0, 14).map((c) => c.category)])];

  openModal('Edit budgets', `
    <p class="muted mb">Leave a field empty to remove that budget.</p>
    ${categories.map((c) => `
      <div class="field">
        <label for="b_${esc(c)}">${icon(c)} ${esc(c)}</label>
        <input type="number" id="b_${esc(c)}" data-cat="${esc(c)}" value="${budgets[c] ?? ''}" placeholder="No budget" min="0" step="100">
      </div>`).join('')}
    <button class="btn primary block mt" id="saveBudgets">Save budgets</button>
  `, {
    onMount(body) {
      $('#saveBudgets', body).onclick = () => {
        $$('input[data-cat]', body).forEach((input) => store.setBudget(input.dataset.cat, input.value));
        closeModal(); refresh({ force: true }); toast('Budgets saved');
      };
    },
  });
}

function showGoalEditor(existing = null) {
  const g = existing && existing.id ? existing : null;
  openModal(g ? `Update ${g.name}` : 'New goal', `
    <div class="field"><label for="gName">Goal</label><input type="text" id="gName" value="${esc(g?.name || '')}" placeholder="Emergency fund"></div>
    <div class="field"><label for="gTarget">Target amount (₹)</label><input type="number" id="gTarget" value="${g?.target || ''}" min="0" step="1000"></div>
    <div class="field"><label for="gSaved">Saved so far (₹)</label><input type="number" id="gSaved" value="${g?.saved || 0}" min="0" step="500"></div>
    <div class="btn-row mt">
      <button class="btn primary" id="saveGoal">Save</button>
      ${g ? '<button class="btn danger" id="delGoal">Delete</button>' : ''}
    </div>
  `, {
    onMount(body) {
      $('#saveGoal', body).onclick = () => {
        const name = $('#gName', body).value.trim();
        const target = Number($('#gTarget', body).value);
        const saved = Number($('#gSaved', body).value) || 0;
        if (!name || !target) { toast('Name and target are required'); return; }
        if (g) store.updateGoal(g.id, { name, target, saved });
        else store.addGoal({ name, target, saved });
        closeModal(); refresh({ force: true }); toast('Goal saved');
      };
      const del = $('#delGoal', body);
      if (del) del.onclick = () => { store.deleteGoal(g.id); closeModal(); refresh({ force: true }); toast('Goal deleted'); };
    },
  });
}

function showRuleEditor() {
  openModal('New rule', `
    <p class="muted mb">If a transaction's merchant or message matches this text, it gets this category. Plain text works; regular expressions also work.</p>
    <div class="field"><label for="rPattern">Match text</label><input type="text" id="rPattern" placeholder="e.g. sharma provision"></div>
    <div class="field">
      <label for="rCat">Category</label>
      <select id="rCat">${CATEGORIES.map((c) => `<option value="${esc(c)}">${icon(c)} ${esc(c)}</option>`).join('')}</select>
    </div>
    <button class="btn primary block mt" id="saveRule">Add rule</button>
  `, {
    onMount(body) {
      $('#saveRule', body).onclick = () => {
        const pattern = $('#rPattern', body).value.trim();
        if (!pattern) { toast('Enter something to match'); return; }
        store.addRule(pattern, $('#rCat', body).value);
        const changed = store.recategoriseAll();
        closeModal(); refresh({ force: true });
        toast(`Rule added — ${changed} transactions updated`);
      };
    },
  });
}

// ---- Import ----------------------------------------------------------------

function showImport() {
  openModal('Import transactions', `
    <div class="notice mb">
      <strong>How to get your SMS in.</strong> Install <em>SMS Backup &amp; Restore</em> (free, Play Store) on your phone, back up SMS only, and transfer the <code>.xml</code> file here. Kuber reads it entirely on your device — nothing is uploaded.
    </div>

    <div class="dropzone" id="dropzone">
      <span class="ico">📂</span>
      <strong>Drop an SMS backup XML here</strong>
      <div class="tiny mt">or click to choose a file · .xml or .json backup</div>
      <input type="file" id="fileInput" accept=".xml,.json,text/xml,application/json" hidden>
    </div>

    <div class="divider"></div>

    <div class="field">
      <label for="pasteBox">Or paste messages directly</label>
      <textarea id="pasteBox" placeholder="Paste one or more SMS. Separate multiple messages with a blank line."></textarea>
      <div class="hint">Format <code>SENDER: message</code> to help bank detection, or just paste the message text.</div>
    </div>
    <button class="btn primary block" id="doPaste">Parse pasted messages</button>

    <div class="divider"></div>
    <div class="btn-row">
      <button class="btn ghost sm" id="doDemo">Load demo data</button>
      <button class="btn ghost sm" id="doManual">Add one manually</button>
    </div>
  `, {
    onMount(body) {
      const zone = $('#dropzone', body);
      const input = $('#fileInput', body);
      zone.onclick = () => input.click();
      input.onchange = () => input.files[0] && handleFile(input.files[0]);
      zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
      zone.ondragleave = () => zone.classList.remove('over');
      zone.ondrop = (e) => {
        e.preventDefault(); zone.classList.remove('over');
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
      };

      $('#doPaste', body).onclick = () => {
        const text = $('#pasteBox', body).value;
        if (!text.trim()) { toast('Nothing pasted'); return; }
        reportImport(store.ingestPastedText(text));
      };
      $('#doDemo', body).onclick = loadDemo;
      $('#doManual', body).onclick = showManualEntry;
    },
  });
}

async function handleFile(file) {
  try {
    const text = await file.text();
    const result = file.name.endsWith('.json') || text.trim().startsWith('{')
      ? store.importBackup(text, { merge: true })
      : store.ingestSmsBackupXml(text);
    reportImport(result);
  } catch (err) {
    toast(`Import failed: ${err.message}`, 5000);
  }
}

function reportImport(result) {
  closeModal();
  refresh({ force: true });

  const parts = [`${result.added} transactions imported`];
  if (result.skipped) parts.push(`${result.skipped} already present`);
  if (result.needsReview) parts.push(`${result.needsReview} need review`);
  toast(parts.join(' · '), 4200);

  if (result.added) switchView('home');
}

function loadDemo() {
  const messages = generateDemoSms({ months: 4 });
  const result = store.ingest(messages);
  store.applySuggestedBudgets();
  closeModal();
  refresh({ force: true });
  switchView('home');
  toast(`Demo loaded — ${result.added} transactions from ${messages.length} messages`, 4200);
}

function showManualEntry() {
  openModal('Add transaction', `
    <div class="field"><label for="mAmount">Amount (₹)</label><input type="number" id="mAmount" step="0.01" min="0"></div>
    <div class="field"><label for="mMerchant">Merchant</label><input type="text" id="mMerchant"></div>
    <div class="field">
      <label for="mCat">Category</label>
      <select id="mCat">${CATEGORIES.map((c) => `<option value="${esc(c)}">${icon(c)} ${esc(c)}</option>`).join('')}</select>
    </div>
    <div class="field">
      <label for="mDir">Direction</label>
      <select id="mDir"><option value="debit">Money out</option><option value="credit">Money in</option></select>
    </div>
    <div class="field"><label for="mDate">Date</label><input type="date" id="mDate" value="${new Date().toISOString().slice(0, 10)}"></div>
    <button class="btn primary block mt" id="saveManual">Add</button>
  `, {
    onMount(body) {
      $('#saveManual', body).onclick = () => {
        const amount = Number($('#mAmount', body).value);
        const merchant = $('#mMerchant', body).value.trim();
        if (!amount || !merchant) { toast('Amount and merchant are required'); return; }
        store.addManualTxn({
          amount, merchant,
          category: $('#mCat', body).value,
          direction: $('#mDir', body).value,
          ts: new Date($('#mDate', body).value).getTime() || Date.now(),
        });
        closeModal(); refresh({ force: true }); toast('Added');
      };
    },
  });
}

// ---- Settings --------------------------------------------------------------

function showSettings() {
  const cfg = llm.getConfig();
  const db = store.getDb();
  const cache = llm.cacheStats();

  openModal('Settings', `
    <div class="card-head"><h3>AI fallback</h3></div>
    <p class="muted mb">Rules handle most messages offline. A key is only used for messages the rules cannot resolve, and for open-ended questions.</p>
    <div class="field">
      <label for="sProvider">Provider</label>
      <select id="sProvider">
        <option value="">Disabled — rules only</option>
        ${llm.PROVIDER_LIST.map((p) => `<option value="${p.id}" ${cfg?.provider === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="sKey">API key</label>
      <input type="password" id="sKey" value="${esc(cfg?.apiKey || '')}" placeholder="Stored only in this browser">
      <div class="hint">Kept in this browser's localStorage and sent directly to the provider. Anyone with access to this browser profile can read it — use a key scoped to this project.</div>
    </div>
    <div class="tiny mb">Merchant cache: ${cache.entries} entries. <button class="link" id="clearCache">Clear</button></div>
    <button class="btn primary block" id="saveLlm">Save AI settings</button>

    <div class="divider"></div>
    <div class="card-head"><h3>Data</h3></div>
    <div class="kv"><span class="k">Transactions</span><span class="v">${db.txns.length}</span></div>
    <div class="kv"><span class="k">Learned merchants</span><span class="v">${Object.keys(db.learning.overrides).length}</span></div>
    <div class="kv"><span class="k">Custom rules</span><span class="v">${db.learning.rules.length}</span></div>
    <div class="kv"><span class="k">Last import</span><span class="v">${db.meta.lastImport ? new Date(db.meta.lastImport).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never'}</span></div>
    <div class="btn-row mt">
      <button class="btn ghost sm" id="doBackup">Export backup</button>
      <button class="btn ghost sm" id="doRecat">Re-categorise all</button>
      <button class="btn danger sm" id="doReset">Erase everything</button>
    </div>

    <div class="divider"></div>
    <div class="card-head"><h3>Privacy</h3></div>
    <p class="tiny">All transaction data lives in this browser's localStorage on this device. There is no server, no account and no telemetry. If you enable the AI fallback, only redacted message text (account numbers, references and phone numbers stripped) and aggregate summaries are sent to your chosen provider. Exporting a backup writes an unencrypted JSON file — treat it like a bank statement.</p>
  `, {
    onMount(body) {
      $('#saveLlm', body).onclick = () => {
        const provider = $('#sProvider', body).value;
        const apiKey = $('#sKey', body).value.trim();
        if (!provider || !apiKey) { llm.setConfig(null); toast('AI fallback disabled'); }
        else { llm.setConfig({ provider, apiKey }); toast(`AI fallback enabled via ${provider}`); }
        closeModal(); refresh({ force: true });
      };
      $('#clearCache', body).onclick = () => { llm.clearCache(); toast('Merchant cache cleared'); closeModal(); };
      $('#doBackup', body).onclick = () => { doBackup(); closeModal(); refresh({ force: true }); };
      $('#doRecat', body).onclick = () => {
        const n = store.recategoriseAll();
        closeModal(); refresh({ force: true }); toast(`${n} transactions re-categorised`);
      };
      $('#doReset', body).onclick = () => {
        if (!confirm('Erase all transactions, budgets, goals and learned corrections? This cannot be undone.')) return;
        store.reset(); closeModal(); refresh({ force: true }); toast('All data erased');
      };
    },
  });
}

// ---- Export ----------------------------------------------------------------

/** Export a full backup and record when it happened, for the iOS reminder. */
function doBackup() {
  download(`kuber-backup-${new Date().toISOString().slice(0, 10)}.json`, store.exportBackup(), 'application/json');
  store.getDb().meta.lastBackup = Date.now();
  store.commit();
  toast(isIOS ? 'Saved — choose "Save to Files" to keep it' : 'Backup downloaded');
}

function download(filename, content, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

function exportReport(kind) {
  const today = new Date().toISOString().slice(0, 10);

  if (kind === 'csv') {
    const rows = [['Date', 'Time', 'Merchant', 'Category', 'Direction', 'Amount', 'Mode', 'Bank', 'Account', 'Reference', 'Balance', 'Confidence', 'Excluded']];
    for (const t of state.txns) {
      const d = new Date(t.ts);
      rows.push([
        d.toISOString().slice(0, 10), d.toTimeString().slice(0, 5), t.merchant, t.category,
        t.direction, t.amount, t.mode, t.bank || '', t.accountLast4 || t.cardLast4 || '',
        t.refId || '', t.balance ?? '', Math.round((t.confidence || 0) * 100) + '%', t.excluded ? 'yes' : 'no',
      ]);
    }
    download(`kuber-transactions-${today}.csv`, toCsv(rows), 'text/csv');
    toast('CSV exported');
    return;
  }

  if (kind === 'month') {
    const rows = [['Month', 'Income', 'Spend', 'Net', 'Transactions']];
    for (const m of state.monthly) rows.push([m.key, m.income.toFixed(2), m.spend.toFixed(2), m.net.toFixed(2), m.count]);
    download(`kuber-monthly-${today}.csv`, toCsv(rows), 'text/csv');
    toast('Monthly report exported');
    return;
  }

  if (kind === 'category') {
    const rows = [['Category', 'Total', 'Share', 'Transactions']];
    const counts = new Map();
    for (const t of state.active) if (isSpend(t)) counts.set(t.category, (counts.get(t.category) || 0) + 1);
    for (const c of state.categoriesAllTime) rows.push([c.category, c.amount.toFixed(2), `${Math.round(c.share * 100)}%`, counts.get(c.category) || 0]);
    download(`kuber-categories-${today}.csv`, toCsv(rows), 'text/csv');
    toast('Category report exported');
    return;
  }

  if (kind === 'subs') {
    const rows = [['Merchant', 'Category', 'Cadence', 'Average', 'Occurrences', 'Lifetime total', 'Last paid', 'Next due', 'Confidence']];
    for (const r of state.recurring) {
      rows.push([
        r.merchant, r.category, r.cadence, r.avgAmount.toFixed(2), r.occurrences, r.totalPaid.toFixed(2),
        new Date(r.lastPaid).toISOString().slice(0, 10), new Date(r.nextDue).toISOString().slice(0, 10),
        `${Math.round(r.confidence * 100)}%`,
      ]);
    }
    download(`kuber-subscriptions-${today}.csv`, toCsv(rows), 'text/csv');
    toast('Subscription report exported');
    return;
  }

  if (kind === 'tax') {
    // Indian financial year runs April to March.
    const now = new Date(state.now);
    const fyStart = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1).getTime();
    const inFy = state.active.filter((t) => t.ts >= fyStart);
    const relevant = ['Investment', 'Insurance', 'Medical', 'Education', 'Tax', 'Salary', 'Freelance', 'Rent'];
    const rows = [['Category', 'Total', 'Transactions', 'Note']];
    for (const category of relevant) {
      const items = inFy.filter((t) => t.category === category);
      if (!items.length) continue;
      rows.push([category, sum(items).toFixed(2), items.length,
        category === 'Investment' ? 'Check 80C eligibility'
          : category === 'Insurance' ? 'Check 80C / 80D eligibility'
          : category === 'Medical' ? 'Check 80D eligibility'
          : category === 'Education' ? 'Check 80E eligibility'
          : category === 'Rent' ? 'HRA supporting evidence' : '']);
    }
    rows.push([]);
    rows.push([`Financial year from ${new Date(fyStart).toISOString().slice(0, 10)}. Derived from SMS parsing — not a substitute for statements or professional advice.`]);
    download(`kuber-tax-summary-${today}.csv`, toCsv(rows), 'text/csv');
    toast('Tax summary exported');
  }
}

// ---- Theme -----------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').setAttribute('content', theme === 'light' ? '#f4f6f5' : '#0b100e');
  store.updateSettings({ theme });
}

// ---- Boot ------------------------------------------------------------------

function init() {
  store.load();
  const saved = store.getDb().settings.theme;
  document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark';

  $$('.nav button').forEach((b) => { b.onclick = () => switchView(b.dataset.view); });
  $('#btnImport').onclick = showImport;
  $('#btnSettings').onclick = showSettings;
  $('#btnTheme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');

  const search = $('#searchInput');
  let debounce;
  search.oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { ui.search = search.value; ui.timelineLimit = 60; renderTimeline(); }, 180);
  };

  store.subscribe(() => { store.invalidate(); });
  requestPersistence();
  refresh({ force: true });
}

init();

// Exposed for the console and for tests.js.
window.kuber = { store, refresh, state: () => state, llm };
