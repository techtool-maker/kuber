/**
 * Hand-rolled SVG charts.
 *
 * No charting library: the whole app must run offline from a single folder, and
 * these five chart types are cheap to draw directly. Every colour comes from a
 * CSS variable so light/dark switching is free.
 */

import { formatINR } from '../engine/intelligence.js';
import { CATEGORY_META } from '../engine/categorizer.js';

const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Donut chart of category spend.
 * Shows the top N slices and rolls the remainder into "Other" — more than
 * about seven slices stops being readable.
 */
export function donutChart(data, { size = 190, thickness = 26, topN = 7 } = {}) {
  const wrap = document.createElement('div');
  const total = data.reduce((a, d) => a + d.amount, 0);
  if (!total) {
    wrap.innerHTML = '<p class="muted center">No spending recorded yet.</p>';
    return wrap;
  }

  const top = data.slice(0, topN);
  const rest = data.slice(topN);
  const slices = rest.length
    ? [...top, { category: 'Other', amount: rest.reduce((a, d) => a + d.amount, 0) }]
    : top;

  const r = size / 2 - thickness / 2;
  const circumference = 2 * Math.PI * r;
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'chart' });

  let offset = 0;
  for (const slice of slices) {
    const fraction = slice.amount / total;
    const colour = CATEGORY_META[slice.category]?.color || '#8b9993';
    const arc = svgEl('circle', {
      cx: size / 2, cy: size / 2, r,
      fill: 'none', stroke: colour, 'stroke-width': thickness,
      'stroke-dasharray': `${fraction * circumference} ${circumference}`,
      'stroke-dashoffset': -offset * circumference,
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    });
    // Node.append() returns undefined, so the title must be built separately
    // rather than chained off the append call.
    const title = svgEl('title');
    title.textContent = `${slice.category}: ${formatINR(slice.amount)} (${Math.round(fraction * 100)}%)`;
    arc.append(title);
    svg.append(arc);
    offset += fraction;
  }

  const centre = svgEl('text', {
    x: size / 2, y: size / 2 - 4, 'text-anchor': 'middle',
    style: 'fill: var(--text); font-size: 19px; font-weight: 700;',
  });
  centre.textContent = formatINR(total, { compact: true });
  svg.append(centre);

  const caption = svgEl('text', { x: size / 2, y: size / 2 + 14, 'text-anchor': 'middle', style: 'fill: var(--text-3); font-size: 10px;' });
  caption.textContent = 'total spend';
  svg.append(caption);

  const holder = document.createElement('div');
  holder.style.cssText = 'display:flex;justify-content:center';
  holder.append(svg);
  wrap.append(holder);

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = slices.map((s) => `
    <span class="item">
      <span class="swatch" style="background:${CATEGORY_META[s.category]?.color || '#8b9993'}"></span>
      ${esc(s.category)} · <strong>${Math.round((s.amount / total) * 100)}%</strong>
    </span>`).join('');
  wrap.append(legend);

  return wrap;
}

/** Grouped bars: income vs spend per month. */
export function monthlyBars(months, { height = 170 } = {}) {
  const wrap = document.createElement('div');
  const data = months.slice(-6);
  if (!data.length) {
    wrap.innerHTML = '<p class="muted center">Not enough history yet.</p>';
    return wrap;
  }

  const w = 320;
  const pad = { top: 12, right: 6, bottom: 24, left: 6 };
  const max = Math.max(...data.flatMap((m) => [m.spend, m.income]), 1);
  const slot = (w - pad.left - pad.right) / data.length;
  const barW = Math.min(15, slot / 3);

  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${height}`, class: 'chart', preserveAspectRatio: 'xMidYMid meet' });
  const plotH = height - pad.top - pad.bottom;

  data.forEach((m, i) => {
    const cx = pad.left + slot * i + slot / 2;
    const incH = (m.income / max) * plotH;
    const spdH = (m.spend / max) * plotH;

    const inc = svgEl('rect', {
      x: cx - barW - 1.5, y: pad.top + plotH - incH, width: barW, height: Math.max(incH, 1),
      rx: 3, fill: 'var(--income)', opacity: 0.9,
    });
    inc.append(svgEl('title'));
    inc.querySelector('title').textContent = `Income ${formatINR(m.income)}`;

    const spd = svgEl('rect', {
      x: cx + 1.5, y: pad.top + plotH - spdH, width: barW, height: Math.max(spdH, 1),
      rx: 3, fill: 'var(--spend)', opacity: 0.9,
    });
    spd.append(svgEl('title'));
    spd.querySelector('title').textContent = `Spend ${formatINR(m.spend)}`;

    const label = svgEl('text', { x: cx, y: height - 8, 'text-anchor': 'middle' });
    label.textContent = new Date(m.ts).toLocaleDateString('en-IN', { month: 'short' });

    svg.append(inc, spd, label);
  });

  wrap.append(svg);
  wrap.insertAdjacentHTML('beforeend', `
    <div class="legend">
      <span class="item"><span class="swatch" style="background:var(--income)"></span>Income</span>
      <span class="item"><span class="swatch" style="background:var(--spend)"></span>Spend</span>
    </div>`);
  return wrap;
}

/** Smoothed area chart of daily spend, with a 7-day moving average overlay. */
export function trendChart(daily, { height = 150, days = 45 } = {}) {
  const wrap = document.createElement('div');
  const data = daily.slice(-days);
  if (data.length < 2) {
    wrap.innerHTML = '<p class="muted center">Not enough data for a trend yet.</p>';
    return wrap;
  }

  const w = 320;
  const pad = { top: 10, right: 4, bottom: 20, left: 4 };
  const plotH = height - pad.top - pad.bottom;
  const plotW = w - pad.left - pad.right;
  const max = Math.max(...data.map((d) => d.amount), 1);
  const x = (i) => pad.left + (i / (data.length - 1)) * plotW;
  const y = (v) => pad.top + plotH - (v / max) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${height}`, class: 'chart', preserveAspectRatio: 'none' });

  const gradId = 'trendGrad';
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    svgEl('stop', { offset: '0%', 'stop-color': 'var(--brand)', 'stop-opacity': '0.38' }),
    svgEl('stop', { offset: '100%', 'stop-color': 'var(--brand)', 'stop-opacity': '0' }),
  );
  defs.append(grad);
  svg.append(defs);

  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.amount).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { d: `${line} L${x(data.length - 1)},${pad.top + plotH} L${x(0)},${pad.top + plotH} Z`, fill: `url(#${gradId})` }));
  svg.append(svgEl('path', { d: line, fill: 'none', stroke: 'var(--brand)', 'stroke-width': 1.8, 'stroke-linejoin': 'round' }));

  // 7-day moving average: the daily series is too spiky to read on its own.
  const window = 7;
  const avg = data.map((_, i) => {
    const slice = data.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((a, d) => a + d.amount, 0) / slice.length;
  });
  svg.append(svgEl('path', {
    d: avg.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    fill: 'none', stroke: 'var(--text-3)', 'stroke-width': 1.2, 'stroke-dasharray': '3 3',
  }));

  const first = svgEl('text', { x: pad.left + 2, y: height - 6, 'text-anchor': 'start' });
  first.textContent = new Date(data[0].ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const last = svgEl('text', { x: w - pad.right - 2, y: height - 6, 'text-anchor': 'end' });
  last.textContent = new Date(data[data.length - 1].ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  svg.append(first, last);

  wrap.append(svg);
  wrap.insertAdjacentHTML('beforeend', '<p class="tiny center">Solid: daily spend · Dashed: 7-day average</p>');
  return wrap;
}

/** GitHub-style calendar heatmap of daily spend. */
export function heatmap(daily, { weeks = 14 } = {}) {
  const wrap = document.createElement('div');
  const data = daily.slice(-weeks * 7);
  if (!data.length) return wrap;

  const amounts = data.map((d) => d.amount).filter((a) => a > 0).sort((a, b) => a - b);
  const p90 = amounts.length ? amounts[Math.floor(amounts.length * 0.9)] : 1;

  const grid = document.createElement('div');
  grid.className = 'heatmap';

  // Pad the start so rows line up with weekdays.
  const firstDay = new Date(data[0].ts).getDay();
  for (let i = 0; i < firstDay; i++) {
    const blank = document.createElement('span');
    blank.className = 'cell';
    blank.style.opacity = '0.25';
    grid.append(blank);
  }

  for (const d of data) {
    const cell = document.createElement('span');
    cell.className = 'cell';
    const intensity = d.amount > 0 ? Math.min(1, d.amount / (p90 || 1)) : 0;
    if (intensity > 0) {
      cell.style.background = `color-mix(in srgb, var(--brand) ${Math.round(18 + intensity * 82)}%, var(--surface-3))`;
    }
    cell.title = `${new Date(d.ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}: ${formatINR(d.amount)}`;
    grid.append(cell);
  }

  wrap.append(grid);
  wrap.insertAdjacentHTML('beforeend', '<p class="tiny mt">Darker squares are heavier spending days.</p>');
  return wrap;
}

/** Circular gauge for the financial health score. */
export function scoreRing(score, { size = 96 } = {}) {
  const r = size / 2 - 8;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const colour = score >= 65 ? 'var(--income)' : score >= 45 ? 'var(--warn)' : 'var(--spend)';

  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  svg.append(svgEl('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': 8 }));
  svg.append(svgEl('circle', {
    cx: size / 2, cy: size / 2, r, fill: 'none', stroke: colour, 'stroke-width': 8,
    'stroke-linecap': 'round',
    'stroke-dasharray': `${pct * circumference} ${circumference}`,
    transform: `rotate(-90 ${size / 2} ${size / 2})`,
  }));
  const text = svgEl('text', { x: size / 2, y: size / 2 + 6, 'text-anchor': 'middle', style: `fill:${colour}; font-size: 22px; font-weight: 750;` });
  text.textContent = String(score);
  svg.append(text);
  return svg;
}
