// Renders the fetched data into one self-contained HTML file (no external assets,
// no local server needed — data and logo are inlined, so file:// works).

import { changeOf } from './metrics.js';

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';

// Brand palette, sampled from the Digital Hub 360 logo.
const BRAND = {
  navy: '#002F87',
  red: '#DB1032',
  orange: '#F2941F',
};

const inr = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const num = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const dec = (n, d = 2) => Number(n || 0).toFixed(d);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

// Drop a file at assets/logo.svg (or .png / .jpg) and it is embedded here.
// Without one, the report falls back to a typographic wordmark.
function logoMarkup() {
  const candidates = [
    ['logo.svg', 'image/svg+xml'],
    ['logo.png', 'image/png'],
    ['logo.jpg', 'image/jpeg'],
    ['logo.jpeg', 'image/jpeg'],
  ];
  for (const [file, mime] of candidates) {
    const full = path.join(ROOT, 'assets', file);
    if (fs.existsSync(full)) {
      const data = fs.readFileSync(full).toString('base64');
      return `<img class="logo" src="data:${mime};base64,${data}" alt="Digital Hub 360">`;
    }
  }
  return `<span class="wordmark">Digital<span class="wordmark-alt">Hub</span><span class="wordmark-red">360</span></span>`;
}

// Shown only on the live preview, never on a downloaded copy — a client's report
// should not carry a refresher that points back at this machine.
const LIVE_CONTROL = `<div class="live">
  <span>Auto-refresh</span>
  <select id="live-every">
    <option value="0">Off</option>
    <option value="60">Every minute</option>
    <option value="300">Every 5 minutes</option>
    <option value="900">Every 15 minutes</option>
  </select>
  <button type="button" id="live-now">Refresh now</button>
  <span class="live-age" id="live-age"></span>
</div>
<script>
(function () {
  var sel = document.getElementById('live-every');
  var age = document.getElementById('live-age');
  var built = Date.now();
  var timer = null;

  // The chosen interval has to outlive the reload it causes, so it is remembered
  // rather than reset to Off every time the page comes back.
  try {
    var saved = localStorage.getItem('dh360-live-every');
    if (saved !== null) sel.value = saved;
  } catch (e) {}

  function schedule() {
    if (timer) { clearInterval(timer); timer = null; }
    var secs = Number(sel.value || 0);
    if (secs > 0) timer = setInterval(function () { location.reload(); }, secs * 1000);
  }

  function tick() {
    var s = Math.round((Date.now() - built) / 1000);
    age.textContent = s < 60
      ? 'updated ' + s + 's ago'
      : 'updated ' + Math.floor(s / 60) + 'm ' + (s % 60) + 's ago';
  }

  sel.addEventListener('change', function () {
    try { localStorage.setItem('dh360-live-every', sel.value); } catch (e) {}
    schedule();
  });
  document.getElementById('live-now').addEventListener('click', function () { location.reload(); });

  schedule();
  tick();
  setInterval(tick, 1000);
}());
</script>`;

// `prev` is the same figure for the comparison window, already formatted. When it is
// present the card reads previous \u2192 current, so the change is visible as two
// numbers rather than only as a percentage you have to work backwards from.
function stat(label, value, sub, tone = '', delta = '', prev = null, prevLabel = '') {
  const body = prev != null
    ? `<span class="stat-pair">
         <span class="stat-prev">${esc(prev)}</span>
         <span class="stat-arrow" aria-hidden="true">\u2192</span>
         <span class="stat-value">${esc(value)}</span>
       </span>
       <span class="stat-scale"><span>${esc(prevLabel || 'previous')} \u2192 now</span>${delta}</span>`
    : `<span class="stat-value">${esc(value)}${delta}</span>`;

  return `<div class="stat ${tone}"><span class="stat-label">${esc(label)}</span>
    ${body}
    ${sub ? `<span class="stat-sub">${esc(sub)}</span>` : ''}</div>`;
}

// Change against the comparison window, as a small pill next to the value. Direction,
// colour and whether a percentage is even appropriate all come from the metric itself
// — see src/metrics.js — rather than from a flag passed at each call site.
function deltaPill(metric, cur, prev, { title = '' } = {}) {
  const change = changeOf(metric, cur, prev);
  if (!change) return '';
  return `<span class="delta ${change.tone}" title="${esc(title)}">${esc(change.text)}</span>`;
}

const fmtDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

function compareLine(previous, broke = false, current = null) {
  if (!previous) return '';
  const now = current ? `${fmtDay(current.since)} \u2013 ${fmtDay(current.until)}` : 'this period';
  const label = previous.days === 1 ? 'the day before' : `the previous ${previous.days} days`;
  if (broke) {
    return `<p class="compare-line warn-line">Could not load ${esc(label)} (${esc(fmtDay(previous.since))} – ${esc(fmtDay(previous.until))}), so no change figures are shown. Refresh to try again.</p>`;
  }
  return `<p class="compare-line">${esc(now)} <strong>vs</strong> ${esc(fmtDay(previous.since))} – ${esc(fmtDay(previous.until))} <span class="muted">(${esc(label)})</span></p>`;
}

function goalBanner(goals) {
  if (!goals || (!goals.goals?.length && !goals.objectives?.length)) return '';
  const primary = goals.goals?.[0];
  const others = (goals.goals || []).slice(1);
  return `<div class="goal">
    <span class="goal-label">Conversion goal</span>
    <span class="goal-value">${esc(primary ? primary.label : goals.objectives.join(', '))}</span>
    ${primary && others.length
      ? `<span class="goal-note">also running: ${esc(others.map((g) => g.label).join(', '))}</span>`
      : ''}
    ${goals.objectives?.length
      ? `<span class="goal-note">objective: ${esc(goals.objectives.join(', '))}</span>`
      : ''}
  </div>`;
}

const LEVEL_HEADING = { campaign: 'Campaign', adset: 'Ad set', ad: 'Ad' };

// Colour the statuses your team actually uses, so the funnel reads at a glance.
// One colour per stage, none shared. The old map keyed off raw spellings, so two
// spellings of the same outcome could take different colours and two different
// outcomes could take the same one.
const STAGE_TONE = {
  Qualified: 'stage-qualified',
  'Not qualified': 'stage-notqualified',
  Junk: 'stage-junk',
  'No response': 'stage-noresponse',
  'In progress': 'stage-inprogress',
  Closed: 'stage-closed',
  'New enquiry': 'stage-new',
  Repeated: 'stage-repeated',
  Cancelled: 'stage-cancelled',
  Unmapped: 'stage-unmapped',
};
const STAGE_ORDER = ['Closed', 'Qualified', 'In progress', 'New enquiry', 'No response',
  'Not qualified', 'Repeated', 'Cancelled', 'Junk', 'Unmapped'];

// A campaign whose CRM tab could not be read must say so. Silently falling back to
// the platform's own numbers is how a report ends up disagreeing with the sheet.
function crmErrorBlock(errors) {
  if (!errors?.length) return '';
  return `<section class="channel"><h3>CRM sheet</h3>
    ${errors.map((e) => `<p class="error">${esc(e.campaign)}: ${esc(e.message)}</p>`).join('')}
  </section>`;
}

function statusStrip(t, adLeads = null) {
  const entries = STAGE_ORDER
    .filter((stage) => t.stages?.[stage])
    .map((stage) => [stage, t.stages[stage]]);
  if (!entries.length) return '';
  const total = entries.reduce((sum, [, n]) => sum + n, 0) || 1;
  const unmapped = Object.entries(t.unmappedValues || {}).sort((a, b) => b[1] - a[1]);

  return `<div class="statuses">
    <div class="statuses-head">
      <span>${t.fromSheet
        ? `Lead outcomes from your CRM sheet${t.crmTabs?.length ? ` \u00b7 ${esc(t.crmTabs.join(', '))}` : ''}`
        : 'Lead outcomes from your CRM'}</span>
      <span class="muted">${adLeads != null
        ? `${num(total)} CRM leads matched of ${num(adLeads)} ad leads`
        : `${num(total)} leads with a status`}</span>
    </div>
    <div class="status-bar">
      ${entries.map(([stage, n]) => `<span class="seg ${STAGE_TONE[stage]}" style="width:${(n / total) * 100}%"
        title="${esc(stage)}: ${n}"></span>`).join('')}
    </div>
    <div class="status-legend">
      ${entries.map(([stage, n]) => `<span class="legend-item"><i class="dot ${STAGE_TONE[stage]}"></i>${esc(stage)}
        <strong>${num(n)}</strong> <span class="muted">${dec((n / total) * 100, 0)}% of ${num(total)} CRM leads</span></span>`).join('')}
    </div>
    ${unmapped.length
      ? `<p class="crm-note warn">Not counted as any outcome \u2014 nobody has mapped ${
          unmapped.map(([raw, n]) => `\u201c${esc(raw)}\u201d (${num(n)})`).join(', ')
        }. Tell me which stage each belongs to and they will be counted.</p>`
      : ''}
    ${t.crmServiceFilters?.length
      ? `<p class="crm-note">Counting only leads that asked for ${esc(t.crmServiceFilters.join(' or '))}${
          t.crmFromUrl ? `, matched to the campaign by the landing page URL` : ''
        }. Leads this campaign brought that asked for something else are not counted here.</p>`
      : (Object.keys(t.crmServices || {}).length > 1
        ? `<p class="crm-note">Counting every service this campaign brought${
            t.crmFromUrl ? ` (${num(t.crmFromUrl)} matched from the landing page URL)` : ''
          }: ${Object.entries(t.crmServices).sort((a, b) => b[1] - a[1])
            .map(([name, n]) => `${esc(name)} ${num(n)}`).join(', ')}.</p>`
        : '')}
    ${t.crmNoDateColumn
      ? `<p class="crm-note warn">That CRM tab has no date column, so these outcomes are NOT limited to the report's date range \u2014 they cover the whole tab.</p>`
      : ''}
    ${t.crmUndated
      ? `<p class="crm-note">${num(t.crmUndated)} CRM row${t.crmUndated > 1 ? 's' : ''} had an unreadable date and ${t.crmUndated > 1 ? 'were' : 'was'} left out of this period.</p>`
      : ''}
  </div>`;
}


// ---------------------------------------------------------------------------
// Trend charts — day-by-day spend and leads, so "is this going up or down"
// is a shape you see rather than a table you have to read.
//
// Two colours only, so the same pair distinguishes Meta from Google everywhere
// a chart in this report shows both: navy-lift for Meta, orange for Google.
// Both were run through the palette validator (OKLCH lightness band, CVD
// separation, normal-vision floor) against this report's own light and dark
// chart surfaces — the dark-mode orange step (#cc7a12) is a validator-picked
// darker step of the same hue, not the UI's --orange, because the UI orange is
// too light to clear the dark-mode lightness band for a line/marker color.
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

function niceMax(max) {
  if (max <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const normalized = max / magnitude;
  const step = [1, 2, 2.5, 5, 10].find((s) => s >= normalized) ?? 10;
  return step * magnitude;
}

// The metrics every trend section plots, in the order they appear. `value` returns
// null — not 0 — when the number is undefined for that day, so a cost-per-X on a
// day with no closures leaves a gap in the line instead of a false ₹0.
// `crm: true` marks the metrics that are NOT drawn from the same population as the
// lead count. Meta measures leads onsite (instant lead forms) and the CRM statuses
// offsite (website pixel), and back-dates each status to the ad that produced the
// lead — days later. So a day's "qualified" is not a share of that day's "leads",
// and on a low-volume day it can legitimately exceed it. Anything flagged here gets
// a caveat printed beside the charts so the two are never read as one funnel.
const METRICS = [
  { key: 'spend', label: 'Spend / day', fmt: inr, value: (d) => d.spend ?? null },
  { key: 'leads', label: 'Leads / day', fmt: num, int: true, value: (d) => d.leads ?? null },
  {
    key: 'qualified',
    label: 'Qualified marked / day',
    fmt: num,
    int: true,
    crm: true,
    value: (d) => d.qualified ?? null,
  },
  {
    key: 'closed',
    label: 'Closed marked / day',
    fmt: num,
    int: true,
    crm: true,
    value: (d) => d.closed ?? null,
  },
  {
    key: 'cpl',
    label: 'Cost per lead / day',
    fmt: inr,
    value: (d) => (d.leads > 0 ? d.spend / d.leads : null),
  },
  {
    key: 'cpql',
    label: 'Cost per qualified / day',
    fmt: inr,
    crm: true,
    value: (d) => (d.qualified > 0 ? d.spend / d.qualified : null),
  },
  {
    key: 'cpClosure',
    label: 'Cost per closure / day',
    fmt: inr,
    crm: true,
    value: (d) => (d.closed > 0 ? d.spend / d.closed : null),
  },
];

const CRM_TREND_NOTE = `<p class="trend-note">
  <strong>Reading the quality charts.</strong> Qualified and closed come from your CRM's
  status sync. Meta records those on the website pixel and credits each one back to the
  <em>ad that produced the lead</em> — usually days later — while the lead count is Meta
  lead-form submissions only. The two are measured on different surfaces, so a day's
  qualified is <em>not</em> a share of that day's leads and on a quiet day can even exceed
  it. Read these as trends over the period, not as day-by-day ratios — and expect the last
  few days to keep rising as your team works through the leads.
</p>`;

// A metric earns a chart only when at least one day actually has a number for it.
// This is what keeps "Qualified / day" off a Google section whose API cannot
// report per-day CRM status, instead of drawing an empty axis.
const metricHasData = (metric, rows) => rows.some((d) => metric.value(d) != null);

// First half vs second half of the series — a plain, honest "is it trending up
// or down", not a forecast. Neutral wording and neutral ink: on a cost metric
// "up" is bad and on leads it is good, so the chart states the direction and
// leaves the judgement to the reader.
function trendDelta(values) {
  const known = values.filter((v) => v != null);
  if (known.length < 4) return null;
  const mid = Math.floor(known.length / 2);
  const avg = (rows) => rows.reduce((s, v) => s + v, 0) / rows.length;
  const first = avg(known.slice(0, mid));
  const second = avg(known.slice(mid));
  if (first <= 0) return null;
  const pct = ((second - first) / first) * 100;
  if (Math.abs(pct) < 5) return { label: 'steady across the period', arrow: '→' };
  return {
    label: `${pct > 0 ? 'up' : 'down'} ${Math.round(Math.abs(pct))}% from the start of the period to the end`,
    arrow: pct > 0 ? '↑' : '↓',
  };
}

// One chart. `series` items are { label, colorVar, values: [number|null] } over a
// shared `dates` axis. Values are pre-formatted server-side into the hover payload
// so the tooltip never has to re-implement ₹ formatting in the browser.
function lineChartSVG({ dates, series, fmt, int = false, area = false, height = 150 }) {
  if (dates.length < 2) return { svg: '<p class="chart-empty">Not enough days in this range to chart.</p>', payload: null };

  const W = 600;
  const padL = 54;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = height - padT - padB;

  const allValues = series.flatMap((s) => s.values).filter((v) => v != null);
  const maxVal = niceMax(Math.max(1, ...allValues));
  const x = (i) => padL + (dates.length === 1 ? 0 : (i / (dates.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / maxVal) * plotH;

  const yTicks = [0, 0.5, 1].map((f) => maxVal * f);
  const gridlines = yTicks
    .map((v) => {
      const line = `<line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="chart-grid"/>`;
      // A count axis whose midpoint lands on 2.5 would print "3" next to a line
      // drawn at 2.5. Keep the gridline, drop the label that would misstate it.
      if (int && !Number.isInteger(v)) return line;
      return `${line}
      <text x="${padL - 8}" y="${y(v).toFixed(1)}" class="chart-axis" text-anchor="end" dominant-baseline="middle">${esc(fmt(v))}</text>`;
    })
    .join('');

  const tickIdx = dates.length > 6
    ? [0, Math.floor((dates.length - 1) / 2), dates.length - 1]
    : [0, dates.length - 1];
  const xLabels = [...new Set(tickIdx)]
    .map(
      (i) => `<text x="${x(i).toFixed(1)}" y="${height - 7}" class="chart-axis"
        text-anchor="${i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle'}">${esc(shortDate(dates[i]))}</text>`,
    )
    .join('');

  const seriesSvg = series
    .map((s) => {
      // Break the path wherever a day has no value, so a gap reads as "no data"
      // rather than a line dropping to the floor.
      const segments = [];
      let current = [];
      s.values.forEach((v, i) => {
        if (v == null) {
          if (current.length) segments.push(current);
          current = [];
        } else {
          current.push([x(i), y(v)]);
        }
      });
      if (current.length) segments.push(current);

      const paths = segments
        .map((seg) => {
          const d = seg.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
          // A lone point has no line to draw — give it a dot so the day still shows.
          if (seg.length === 1) {
            return `<circle cx="${seg[0][0].toFixed(1)}" cy="${seg[0][1].toFixed(1)}" r="2.5" fill="var(${s.colorVar})"/>`;
          }
          const fill = area
            ? `<path d="${d} L${seg[seg.length - 1][0].toFixed(1)},${y(0)} L${seg[0][0].toFixed(1)},${y(0)} Z" fill="var(${s.colorVar})" opacity=".1"/>`
            : '';
          return `${fill}<path d="${d}" fill="none" stroke="var(${s.colorVar})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        })
        .join('');

      // End marker + label on the last day that actually has a value.
      let lastIdx = -1;
      for (let i = s.values.length - 1; i >= 0; i -= 1) {
        if (s.values[i] != null) { lastIdx = i; break; }
      }
      const endMark = lastIdx === -1 ? '' : (() => {
        const ex = x(lastIdx);
        const ey = y(s.values[lastIdx]);
        // 11px clears the marker's 4px radius plus its 2px surface ring on both
        // sides, so the label never touches the dot it belongs to.
        const flip = ex + 11 > W - padR - 44;
        return `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4" fill="var(${s.colorVar})" stroke="var(--card)" stroke-width="2"/>
          <text x="${(flip ? ex - 11 : ex + 11).toFixed(1)}" y="${ey.toFixed(1)}" class="chart-endlabel"
            text-anchor="${flip ? 'end' : 'start'}" dominant-baseline="middle">${esc(fmt(s.values[lastIdx]))}</text>`;
      })();

      return paths + endMark;
    })
    .join('');

  // The hover layer: one crosshair the script moves, plus focusable stops so the
  // same readout is reachable from the keyboard, not hover alone.
  const hover = `<g class="chart-cursor" aria-hidden="true">
      <line class="chart-crosshair" y1="${padT}" y2="${padT + plotH}"/>
      ${series.map((s) => `<circle class="chart-cursor-dot" r="4.5" fill="var(${s.colorVar})" stroke="var(--card)" stroke-width="2"/>`).join('')}
    </g>`;

  const payload = {
    x: dates.map((_, i) => Number(x(i).toFixed(1))),
    dates: dates.map(shortDate),
    series: series.map((s) => ({
      name: s.label,
      color: `var(${s.colorVar})`,
      y: s.values.map((v) => (v == null ? null : Number(y(v).toFixed(1)))),
      text: s.values.map((v) => (v == null ? null : fmt(v))),
    })),
  };

  const svg = `<svg viewBox="0 0 ${W} ${height}" class="chart-svg" preserveAspectRatio="none" role="img"
    aria-label="${esc(series.map((s) => s.label).join(' and '))} by day">
    ${gridlines}
    <line x1="${padL}" x2="${W - padR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="chart-baseline"/>
    ${seriesSvg}
    ${hover}
    ${xLabels}
    <rect class="chart-capture" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
  </svg>`;

  return { svg, payload };
}

function chartLegend(series) {
  if (series.length < 2) return '';
  return `<div class="chart-legend">${series
    .map((s) => `<span class="chart-legend-item"><i class="chart-key" style="background:var(${s.colorVar})"></i>${esc(s.label)}</span>`)
    .join('')}</div>`;
}

// One card = one metric. The hover payload rides on the card as JSON; the shared
// script at the end of the document wires every card the same way.
function chartCard({ title, dates, series, fmt, int, area }) {
  const { svg, payload } = lineChartSVG({ dates, series, fmt, int, area });
  const delta = series.length === 1 ? trendDelta(series[0].values) : null;
  return `<figure class="trend-chart"${payload ? ` data-chart='${esc(JSON.stringify(payload))}'` : ''}>
    <figcaption class="trend-chart-head">
      <span class="trend-chart-title">${esc(title)}</span>
      ${delta ? `<span class="chart-delta">${delta.arrow} ${esc(delta.label)}</span>` : ''}
    </figcaption>
    ${chartLegend(series)}
    <div class="chart-plot">
      ${svg}
      <div class="chart-tip" hidden></div>
    </div>
  </figure>`;
}

// The table view — every plotted number, without hovering. One table per section
// rather than per chart, so the whole day reads across in one row.
function trendTable(dates, metrics, rows, seriesNames) {
  const cols = [];
  for (const m of metrics) {
    for (const s of seriesNames) {
      cols.push({
        head: seriesNames.length > 1 ? `${s.label} — ${m.label.replace(' / day', '')}` : m.label.replace(' / day', ''),
        cell: (i) => {
          const v = m.value(s.rows[i] || {});
          return v == null ? '—' : m.fmt(v);
        },
      });
    }
  }
  return `<details class="chart-table">
    <summary>Show daily numbers</summary>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th>${cols.map((c) => `<th class="n">${esc(c.head)}</th>`).join('')}</tr></thead>
      <tbody>${dates
        .map(
          (d, i) => `<tr><td>${esc(shortDate(d))}</td>${cols.map((c) => `<td class="n">${esc(c.cell(i))}</td>`).join('')}</tr>`,
        )
        .join('')}</tbody>
    </table></div>
  </details>`;
}

// One platform's own daily numbers — a separate chart per metric it can report.
function platformTrend(colorVar, daily) {
  if (!daily?.length) return '';
  const dates = daily.map((d) => d.date);
  const live = METRICS.filter((m) => metricHasData(m, daily));
  if (!live.length) return '';

  const cards = live
    .map((m) =>
      chartCard({
        title: m.label,
        dates,
        fmt: m.fmt,
        int: m.int,
        area: true,
        series: [{ label: m.label, colorVar, values: daily.map((d) => m.value(d)) }],
      }),
    )
    .join('');

  return `<div class="trend">
    <h4>Trend</h4>
    <div class="trend-grid">${cards}</div>
    ${live.some((m) => m.crm) ? CRM_TREND_NOTE : ''}
    ${trendTable(dates, live, daily, [{ label: '', rows: daily }])}
  </div>`;
}

// The combined view at the end: the same metrics with both platforms on one axis,
// so the whole account reads in a single pass.
function overallTrendBlock(metaDaily, googleDaily) {
  const hasMeta = metaDaily?.length > 0;
  const hasGoogle = googleDaily?.length > 0;
  if (!hasMeta && !hasGoogle) return '';

  // Align both platforms onto one date axis. A day a platform never reported is
  // left null, not zeroed — the gap says "no data", which is the truth.
  const dates = [...new Set([...(metaDaily || []), ...(googleDaily || [])].map((d) => d.date))].sort();
  const align = (rows) => dates.map((date) => (rows || []).find((r) => r.date === date) || {});
  const metaRows = align(metaDaily);
  const googleRows = align(googleDaily);

  const platforms = [
    hasMeta && { label: 'Meta Ads', colorVar: '--chart-meta', rows: metaRows },
    hasGoogle && { label: 'Google Ads', colorVar: '--chart-google', rows: googleRows },
  ].filter(Boolean);

  const live = METRICS.filter((m) => platforms.some((p) => metricHasData(m, p.rows)));
  if (!live.length) return '';

  const cards = live
    .map((m) => {
      // Only plot the platforms that can actually report this metric, so a Google
      // line never appears flat-null under a Meta-only quality chart.
      const series = platforms
        .filter((p) => metricHasData(m, p.rows))
        .map((p) => ({ label: p.label, colorVar: p.colorVar, values: p.rows.map((r) => m.value(r)) }));
      return chartCard({
        title: m.label.replace(' / day', ' / day — all platforms'),
        dates,
        series,
        fmt: m.fmt,
        int: m.int,
      });
    })
    .join('');

  return `<section class="channel trend-overall">
    <h3>Overall trend — everything together</h3>
    <div class="trend-grid">${cards}</div>
    ${live.some((m) => m.crm) ? CRM_TREND_NOTE : ''}
    ${trendTable(dates, live, null, platforms)}
  </section>`;
}

// Wired once for every chart in the document. Kept inline and dependency-free so
// the saved report still hovers correctly opened straight off disk.
const CHART_SCRIPT = `<script>
(function () {
  var VB = 600;
  document.querySelectorAll('.trend-chart[data-chart]').forEach(function (card) {
    var data;
    try { data = JSON.parse(card.getAttribute('data-chart')); } catch (e) { return; }
    var svg = card.querySelector('.chart-svg');
    var plot = card.querySelector('.chart-plot');
    var tip = card.querySelector('.chart-tip');
    var cursor = card.querySelector('.chart-cursor');
    var crosshair = card.querySelector('.chart-crosshair');
    var dots = card.querySelectorAll('.chart-cursor-dot');
    if (!svg || !tip || !cursor) return;

    function show(i) {
      var box = svg.getBoundingClientRect();
      var scaleX = box.width / VB;
      var px = data.x[i] * scaleX;

      crosshair.setAttribute('x1', data.x[i]);
      crosshair.setAttribute('x2', data.x[i]);

      // Values lead, series names follow — and every name goes in as text, never
      // as markup.
      tip.textContent = '';
      var head = document.createElement('div');
      head.className = 'chart-tip-date';
      head.textContent = data.dates[i];
      tip.appendChild(head);

      data.series.forEach(function (s, si) {
        var dot = dots[si];
        var v = s.text[i];
        if (dot) {
          if (v == null) { dot.style.display = 'none'; }
          else {
            dot.style.display = '';
            dot.setAttribute('cx', data.x[i]);
            dot.setAttribute('cy', s.y[i]);
          }
        }
        var row = document.createElement('div');
        row.className = 'chart-tip-row';
        var key = document.createElement('i');
        key.className = 'chart-tip-key';
        key.style.background = s.color;
        var val = document.createElement('strong');
        val.textContent = v == null ? 'no data' : v;
        row.appendChild(key);
        row.appendChild(val);
        if (data.series.length > 1) {
          var nm = document.createElement('span');
          nm.textContent = s.name;
          row.appendChild(nm);
        }
        tip.appendChild(row);
      });

      cursor.classList.add('on');
      tip.hidden = false;
      // Keep the tooltip inside the card rather than letting it clip at the edge.
      var w = tip.offsetWidth;
      var left = Math.max(4, Math.min(px - w / 2, plot.clientWidth - w - 4));
      tip.style.left = left + 'px';
    }

    function hide() {
      cursor.classList.remove('on');
      tip.hidden = true;
    }

    function nearest(clientX) {
      var box = svg.getBoundingClientRect();
      var vbX = (clientX - box.left) / (box.width / VB);
      var best = 0;
      var bestD = Infinity;
      for (var i = 0; i < data.x.length; i++) {
        var d = Math.abs(data.x[i] - vbX);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    svg.addEventListener('pointermove', function (e) { show(nearest(e.clientX)); });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointerdown', function (e) { show(nearest(e.clientX)); });

    // Keyboard: the same readout without a pointer.
    var at = 0;
    svg.setAttribute('tabindex', '0');
    svg.addEventListener('focus', function () { show(at); });
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { at = Math.min(at + 1, data.x.length - 1); show(at); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { at = Math.max(at - 1, 0); show(at); e.preventDefault(); }
    });
  });
})();
</script>`;

// Spelled out on the campaign row itself, because that is where someone checking a
// figure against their own filter is looking. The qualified count is per CAMPAIGN —
// a person can click a pet-sitting ad and ask about boarding — and without the split
// printed here the number looks wrong to anyone who filtered the sheet by service.
function crmBasis(c) {
  const parts = [`CRM tab: ${c.crmTab || 'linked'}`];
  if (c.crmService) {
    parts.push(`counting only leads that asked for ${c.crmService}`);
  } else {
    const services = Object.entries(c.crmServices || {}).sort((a, b) => b[1] - a[1]);
    if (services.length > 1) {
      parts.push(`counting every service this campaign brought: ${services.map(([n, v]) => `${n} ${v}`).join(', ')}`);
    }
  }
  return esc(parts.join(' \u00b7 '));
}

function channelBlock(title, data, opts = {}) {
  if (!data) return '';
  if (data.error) {
    return `<section class="channel"><h3>${esc(title)}</h3>
      <p class="error">${esc(data.error)}</p></section>`;
  }

  const t = data.totals;
  const heading = LEVEL_HEADING[data.level] || 'Campaign';
  // Quality columns are always shown — an empty column tells you the pipeline isn't
  // connected, which is information. Hiding them just looks like the feature is missing.
  const showQuality = true;
  // This channel's own quality data decides what this channel shows — a sibling
  // platform having statuses says nothing about this one.
  const hasQuality = t.hasQualityData || t.hasCrm || opts.hasQuality;

  // A pixel firing far more often than real form submissions is a broken pixel,
  // not a good month — say so rather than printing it as a result.
  const pixelSuspect = t.pixelLeads > Math.max(t.clicks, 1) * 1.5;

  const p = opts.prior || null;
  const pl = opts.prevLabel || 'previous';
  const d = (metric, cur, prev) => (p ? deltaPill(metric, cur, prev, { title: opts.vs || '' }) : '');

  const rows = data.campaigns.length
    ? data.campaigns
        .map(
          (c) => `<tr>
            <td>${esc(c.name)}${c.parent ? `<span class="parent">${esc(c.parent)}</span>` : ''}${
              c.crmSource === 'sheet' ? `<span class="parent">${crmBasis(c)}</span>` : ''}</td>
            <td class="n">${inr(c.spend)}</td>
            <td class="n">${num(c.impressions)}</td>
            <td class="n">${num(c.clicks)}</td>
            <td class="n">${dec(c.ctr)}%</td>
            <td class="n">${inr(c.cpc)}</td>
            <td class="n strong">${num(c.leads)}</td>
            <td class="n">${c.leads ? inr(c.spend / c.leads) : '—'}</td>
            <td class="n">${c.qualified != null ? num(c.qualified) : '—'}</td>
            <td class="n">${c.qualified ? inr(c.spend / c.qualified) : '—'}</td>
            <td class="n">${c.closed != null ? num(c.closed) : '—'}</td>
            <td class="n">${c.closed ? inr(c.spend / c.closed) : '—'}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="${showQuality ? 12 : 8}" class="muted">No activity in this period.</td></tr>`;

  return `<section class="channel">
    <h3>${esc(title)}</h3>
    <div class="stats">
      ${stat('Leads', num(t.leads),
        t.crmServiceFilters?.length
          ? `asked for ${t.crmServiceFilters.join(' or ')} \u00b7 ${num(t.adLeads)} ${title === 'Meta Ads' ? 'Meta leads' : 'Google conversions'} in total`
          : (title === 'Meta Ads' ? 'Meta lead forms' : 'Google Ads conversions'),
        'accent', d('leads', t.leads, p?.leads), p ? num(p.leads) : null, pl)}
      ${stat('Qualified', hasQuality ? num(t.qualified) : '—',
        hasQuality ? `${dec(t.qualifyRate, 0)}% of ${num(t.leads)} ${t.crmServiceFilters?.length ? 'matched' : 'ad'} leads` : 'not tracked', 'accent',
        hasQuality ? d('qualified', t.qualified, p?.qualified) : '',
        p && hasQuality ? num(p.qualified) : null, pl)}
      ${stat('Closed', hasQuality ? num(t.closed) : '—',
        hasQuality ? `${dec((t.closed / (t.crmTotal || 1)) * 100, 0)}% of ${num(t.crmTotal)} CRM leads` : 'not tracked', 'win',
        hasQuality ? d('closed', t.closed, p?.closed) : '',
        p && hasQuality ? num(p.closed) : null, pl)}
      ${stat('Cost per closure', hasQuality && t.closed ? inr(t.cpClosure) : '—', '', '',
        hasQuality && t.closed ? d('costPerClosure', t.cpClosure, p?.cpClosure) : '',
        p && hasQuality && p.closed ? inr(p.cpClosure) : null, pl)}
    </div>

    <details class="more">
      <summary>See more</summary>
      <div class="stats">
        ${stat('Spend', inr(t.spend), '', '', d('spend', t.spend, p?.spend), p ? inr(p.spend) : null, pl)}
        ${stat('Impressions', num(t.impressions), '', '', d('impressions', t.impressions, p?.impressions),
          p ? num(p.impressions) : null, pl)}
        ${stat('Clicks', num(t.clicks), `${dec(t.ctr)}% CTR`, '', d('clicks', t.clicks, p?.clicks),
          p ? num(p.clicks) : null, pl)}
        ${stat('Cost per lead', t.leads ? inr(t.cpl) : '—', '', '',
          t.leads ? d('costPerLead', t.cpl, p?.cpl) : '', p && p.leads ? inr(p.cpl) : null, pl)}
        ${stat('Cost per qualified lead', hasQuality && t.qualified ? inr(t.cpql) : '—', '', '',
          hasQuality && t.qualified ? d('costPerQualified', t.cpql, p?.cpql) : '',
          p && hasQuality && p.qualified ? inr(p.cpql) : null, pl)}
        ${stat('Not qualified', hasQuality ? num(t.disqualified) : '—',
          hasQuality ? `${dec((t.disqualified / (t.crmTotal || 1)) * 100, 0)}% of ${num(t.crmTotal)} CRM leads` : 'not tracked',
          '', hasQuality ? d('notQualified', t.disqualified, p?.disqualified) : '',
          p && hasQuality ? num(p.disqualified) : null, pl)}
      </div>
    </details>

    ${t.hasCrm ? statusStrip(t, t.leads) : ''}

    ${t.pixelLeads || t.messaging
      ? `<p class="aside">
          Also recorded: ${num(t.pixelLeads)} website pixel events${t.messaging ? `, ${num(t.messaging)} chats started` : ''}.
          ${pixelSuspect
            ? `<strong class="warn">The pixel reports more events than clicks — it is firing on page views, not form submits, so it is excluded from the lead count above.</strong>`
            : 'Not counted as leads above.'}
        </p>`
      : ''}

    ${platformTrend(title === 'Meta Ads' ? '--chart-meta' : '--chart-google', opts.daily)}

    <div class="table-wrap"><table>
      <thead><tr>
        <th>${esc(heading)}</th>
        <th class="n">Spend</th><th class="n">Impr.</th><th class="n">Clicks</th>
        <th class="n">CTR</th><th class="n">CPC</th>
        <th class="n">Leads</th><th class="n">CPL</th>
        <th class="n">Qual.</th><th class="n">CPQL</th>
        <th class="n">Closed</th><th class="n">Cost/close</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function leadsBlock(leads) {
  if (!leads) return '';
  if (leads.error) {
    return `<section class="channel"><h3>Website leads</h3>
      <p class="error">${esc(leads.error)}</p></section>`;
  }

  const sources = Object.entries(leads.bySource).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...sources.map(([, v]) => v));
  const bars = sources
    .map(
      ([name, count]) => `<div class="bar-row">
        <span class="bar-label">${esc(name)}</span>
        <span class="bar"><span class="bar-fill" style="width:${(count / max) * 100}%"></span></span>
        <span class="bar-value">${count}</span>
      </div>`,
    )
    .join('');

  const cols = leads.columns.slice(0, 6);
  const recent = leads.rows.length
    ? leads.rows
        .slice(0, 25)
        .map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`)
        .join('')
    : `<tr><td colspan="${cols.length}" class="muted">No leads in this period.</td></tr>`;

  const t = leads.tally || {};
  return `<section class="channel">
    <h3>Website leads</h3>
    <div class="stats">
      ${stat('Leads captured', num(leads.count))}
      ${leads.hasStatusColumn ? stat('Qualified', num(t.qualified), '', 'accent') : ''}
      ${leads.hasStatusColumn ? stat('Closed', num(t.closed), '', 'win') : ''}
      ${leads.hasStatusColumn && t.junk ? stat('Junk', num(t.junk)) : ''}
    </div>
    ${!leads.hasStatusColumn
      ? `<p class="aside">No <strong>${esc(leads.statusColumn)}</strong> column in this sheet — add one with values like
         New / Qualified / Closed to get cost per qualified lead and cost per closure.</p>`
      : ''}
    ${sources.length ? `<div class="bars">${bars}</div>` : ''}
    <div class="table-wrap"><table>
      <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${recent}</tbody>
    </table></div>
  </section>`;
}

const SEVERITY = {
  critical: 'Fix first',
  high: 'High impact',
  medium: 'Worth doing',
  info: 'Note',
};

function insightsBlock(insights) {
  if (!insights || (!insights.findings.length && !insights.projections.length)) return '';

  const findings = insights.findings
    .map(
      (f) => `<div class="finding ${f.severity}">
        <div class="finding-head">
          <span class="chip ${f.severity}">${esc(SEVERITY[f.severity] || f.severity)}</span>
          <span class="finding-title">${esc(f.title)}</span>
        </div>
        <p class="finding-detail">${esc(f.detail)}</p>
        <p class="finding-action"><strong>Do this:</strong> ${esc(f.action)}</p>
      </div>`,
    )
    .join('');

  const projections = insights.projections
    .map(
      (p) => `<div class="projection">
        <h4>If you act on the above — ${esc(p.platform)}</h4>
        <div class="proj-grid">
          <div><span class="proj-label">Leads now</span><span class="proj-now">${num(p.currentLeads)}</span></div>
          <div class="proj-arrow">→</div>
          <div><span class="proj-label">Projected leads</span><span class="proj-next">${num(Math.round(p.projectedLeads))}</span></div>
          <div><span class="proj-label">CPL now</span><span class="proj-now">${inr(p.currentCpl)}</span></div>
          <div class="proj-arrow">→</div>
          <div><span class="proj-label">Projected CPL</span><span class="proj-next">${inr(p.projectedCpl)}</span></div>
        </div>
        <p class="proj-headline">${p.upliftPct > 0 ? `About ${dec(p.upliftPct, 0)}% more leads for the same ₹${num(Math.round(p.movable))} of reallocated budget.` : 'Budget is already concentrated in your efficient campaigns.'}</p>
        <details>
          <summary>What this assumes</summary>
          <ul>${p.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
          <p class="proj-caveat">This is arithmetic on your own numbers, not a forecast. Real results depend on
          creative, competition and how the auction responds to a budget change.</p>
        </details>
      </div>`,
    )
    .join('');

  return `<section class="channel insights">
    <h3>Optimisation <span class="internal-tag">internal</span></h3>
    ${findings}
    ${projections}
  </section>`;
}

// Prepaid ad accounts stop delivering the moment they hit zero, usually without
// warning. This is the one number worth checking before the ads go dark.
function balanceBlock(balances) {
  if (!balances?.length) return '';

  // A balance entry (Meta always, Google once you've anchored it) gets an amount.
  // A pace entry (Google, automatic, nothing to set) gets a delivery signal instead —
  // there is no ₹ figure to show, only whether spend has collapsed.
  const rows = balances
    .map((b) => {
      if (b.pace) {
        const dropped = b.pace.status === 'dropped';
        return `<div class="bal ${dropped ? 'empty' : 'ok'}">
          <div class="bal-head">
            <span class="bal-name">${esc(b.platform)}</span>
            <span class="bal-amount pace">${dropped ? `spend ↓${b.pace.droppedPct}%` : 'delivering normally'}</span>
          </div>
          <p class="bal-sub">${esc(b.account)}</p>
          <p class="bal-sub">${
            dropped
              ? `Averaging ${inr(b.pace.recentAvg)}/day vs the usual ${inr(b.pace.baselineAvg)}/day — check funds.`
              : 'Auto-detected from spend pace — no balance set for this account.'
          }</p>
        </div>`;
      }

      const tone = b.empty ? 'empty' : b.low ? 'low' : 'ok';
      const runway =
        b.runwayDays == null
          ? 'no spend in this period'
          : b.runwayDays < 1
            ? 'less than a day at the current rate'
            : `about ${dec(b.runwayDays, b.runwayDays < 10 ? 1 : 0)} days at the current rate`;
      return `<div class="bal ${tone}">
        <div class="bal-head">
          <span class="bal-name">${esc(b.platform || b.account)}</span>
          <span class="bal-amount">${inr(b.available)}</span>
        </div>
        <p class="bal-sub">${esc(b.account)}</p>
        <p class="bal-sub">${b.empty ? 'Out of funds — ads are not delivering.' : esc(runway)}</p>
      </div>`;
    })
    .join('');

  const alarms = balances.filter((b) => (b.pace ? b.pace.status === 'dropped' : b.low));
  const threshold = balances.find((b) => b.threshold)?.threshold;
  const headline = alarms.length
    ? `<p class="bal-alarm">${alarms.length === 1 ? '1 account needs' : `${alarms.length} accounts need`} attention${threshold ? ` — below ${inr(threshold)} or spend has collapsed` : ''}.</p>`
    : '';

  return `<section class="channel balances">
    <h3>Account funds <span class="internal-tag">internal</span></h3>
    ${headline}
    <div class="bal-grid">${rows}</div>
  </section>`;
}

// Says plainly what this block is a total OF. When a client runs on both platforms
// the headline figures are Meta + Google added together, which is invisible from the
// numbers alone — the per-platform sections further down only ever show their own
// share, so the two never appear to reconcile without this.
function sourcesLine(sources) {
  if (!sources?.length) return '';
  const parts = sources.map((s) => {
    const scope = s.campaignCount
      ? `${s.campaignCount} campaign${s.campaignCount > 1 ? 's' : ''}`
      : 'all campaigns';
    return `<span class="src"><i class="src-dot ${s.platform === 'Meta Ads' ? 'meta' : 'google'}"></i>
      ${esc(s.platform)} · ${esc(s.account)} <span class="src-scope">${scope}</span></span>`;
  });
  const note = sources.length > 1
    ? '<p class="src-note">Figures below this line are these sources added together.</p>'
    : '';
  return `<div class="sources">${parts.join('')}${note}</div>`;
}

function clientBlock(client, { internal = false } = {}) {
  const meta = client.meta && !client.meta.error ? client.meta.totals : null;
  const google = client.googleAds && !client.googleAds.error ? client.googleAds.totals : null;
  const spend = (meta?.spend || 0) + (google?.spend || 0);
  const leadCount = (meta?.leads || 0) + (google?.leads || 0);

  // Quality (qualified / closed) can come from the ad platforms — CRM statuses
  // synced back, or sheet rows matched to a campaign — or, for a client with no ad
  // account selected at all, from the lead sheet's own totals.
  //
  // These two must never be mixed. The sheet's totals cover the whole sheet: they
  // are not filtered to the selected account, nor to the campaigns the report is
  // narrowed to, and the sheet may even track a different platform than the one on
  // screen. Using them to "fill in" a platform's genuine zero is how a Meta-only
  // report came to display 31 closures taken from a sheet tab named "Google ads".
  //
  // So: if any ad channel is present, the platforms are the only source. The sheet
  // total is used solely when there is no ad channel to speak for.
  const hasAdChannel = Boolean(meta || google);
  // With one channel the summary row is a copy of that channel's own row, line for
  // line. Printing both invites the reader to look for a difference that cannot exist.
  const channelCount = [meta, google].filter(Boolean).length;
  const platformKnowsQuality = Boolean(meta?.hasQualityData || google?.hasQualityData);

  const qualified = hasAdChannel
    ? (meta?.qualified || 0) + (google?.qualified || 0)
    : client.leads?.tally?.qualified || 0;
  const closed = hasAdChannel
    ? (meta?.closed || 0) + (google?.closed || 0)
    : client.leads?.tally?.closed || 0;

  // "—" rather than "0" when nothing can speak to quality, so an unknown never
  // masquerades as a measured zero.
  const hasQuality = hasAdChannel
    ? platformKnowsQuality
    : Boolean(client.leads?.hasStatusColumn);

  // Prior-window headline, built the same way so like compares with like.
  const pv = client.previous?.client;
  // A comparison window that failed to load must not be read as a window of zeroes.
  // Treating a failed fetch as 0 made every stat show "new", which says "nothing
  // existed before" — the opposite of "I could not find out".
  const priorBroke = Boolean(
    (pv?.meta && pv.meta.error) || (pv?.googleAds && pv.googleAds.error) || (client.previous && !pv),
  );
  const pm = pv?.meta && !pv.meta.error ? pv.meta.totals : null;
  const pg = pv?.googleAds && !pv.googleAds.error ? pv.googleAds.totals : null;
  const prior = pv && !priorBroke ? {
    spend: (pm?.spend || 0) + (pg?.spend || 0),
    leads: (pm?.leads || 0) + (pg?.leads || 0),
    qualified: (pm?.qualified || 0) + (pg?.qualified || 0),
    closed: (pm?.closed || 0) + (pg?.closed || 0),
  } : null;
  const vs = client.previous ? `vs ${fmtDay(client.previous.since)} – ${fmtDay(client.previous.until)}` : '';
  const pLabel = client.previous
    ? (client.previous.days === 1 ? 'day before' : `prev ${client.previous.days} days`)
    : '';
  const d = (metric, cur, prev) => (prior ? deltaPill(metric, cur, prev, { title: vs }) : '');
  const cp = (spend, n) => (n ? spend / n : 0);

  return `<article class="client">
    <header class="client-head">
      <h2>${esc(client.name)}</h2>
      ${sourcesLine(client.sources)}
      ${goalBanner(client.goals)}
      ${compareLine(client.previous, priorBroke, client.range)}
      ${channelCount < 2 ? '' : `<div class="headline">
        ${stat('Leads', num(leadCount), leadCount ? `${inr(spend / leadCount)} per lead` : '', 'accent',
          d('leads', leadCount, prior?.leads), prior ? num(prior.leads) : null, pLabel)}
        ${stat('Qualified', hasQuality ? num(qualified) : '—',
          hasQuality
            ? (qualified ? `${inr(spend / qualified)} per qualified lead` : 'none yet in this period')
            : 'not tracked', 'accent', hasQuality ? d('qualified', qualified, prior?.qualified) : '',
          prior && hasQuality ? num(prior.qualified) : null, pLabel)}
        ${stat('Closed', hasQuality ? num(closed) : '—',
          hasQuality
            ? (closed ? `${inr(spend / closed)} per closure` : 'none yet in this period')
            : 'not tracked', 'win', hasQuality ? d('closed', closed, prior?.closed) : '',
          prior && hasQuality ? num(prior.closed) : null, pLabel)}
        ${stat('Cost per closure', hasQuality && closed ? inr(spend / closed) : '—', '', '',
          hasQuality && closed ? d('costPerClosure', cp(spend, closed), cp(prior?.spend, prior?.closed)) : '',
          prior && hasQuality && prior.closed ? inr(cp(prior.spend, prior.closed)) : null, pLabel)}
      </div>`}
    </header>
    ${channelBlock('Meta Ads', client.meta, { hasQuality, daily: client.metaDaily, prior: pm, vs, prevLabel: pLabel })}
    ${channelBlock('Google Ads', client.googleAds, { hasQuality, daily: client.googleDaily, prior: pg, vs, prevLabel: pLabel })}
    ${crmErrorBlock(client.crmErrors)}
    ${leadsBlock(client.leads)}
    ${overallTrendBlock(client.metaDaily, client.googleDaily)}
    ${internal ? balanceBlock(client.balances) : ''}
    ${internal ? insightsBlock(client.insights) : ''}
  </article>`;
}

// `internal` decides whether this copy is for you or for the client. The internal
// copy carries the optimisation findings and the account balances; the client copy
// is the same performance data with those two sections left out.
export function renderReport({ clients, since, until, generatedAt, internal = false, live = false }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Client Report · ${esc(since)} – ${esc(until)}</title>
<style>
  :root {
    --navy:${BRAND.navy}; --red:${BRAND.red}; --orange:${BRAND.orange};
    --bg:#f4f6fa; --card:#fff; --ink:#101725; --muted:#66708a;
    --line:#e2e7f0; --soft:#f7f9fc;
    /* Chart series colour, validated separately from the brand tokens above —
       see the note above platformTrend() in render.js for why these two
       differ from --navy/--orange rather than reusing them. */
    --chart-meta:#1450be; --chart-google:${BRAND.orange};
  }
  @media (prefers-color-scheme: dark) {
    :root { --navy:#5c86e6; --red:#ff5f79; --orange:#ffb454;
            --bg:#0b1020; --card:#141a2b; --ink:#e8ecf6; --muted:#96a0bb;
            --line:#232c44; --soft:#1a2136;
            --chart-meta:#5c86e6; --chart-google:#cc7a12; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:0 0 64px; background:var(--bg); color:var(--ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1180px; margin:0 auto; padding:0 20px; }

  /* Masthead */
  .masthead { background:var(--navy); color:#fff; padding:26px 0 30px; margin-bottom:26px;
    border-bottom:4px solid var(--red); }
  .masthead .wrap { display:flex; align-items:center; justify-content:space-between;
    gap:20px; flex-wrap:wrap; }
  .logo { height:46px; width:auto; display:block;
    background:#fff; padding:7px 12px; border-radius:10px; }
  .wordmark { font-size:22px; font-weight:700; letter-spacing:-.01em; color:#fff; }
  .wordmark-alt { color:#fff; opacity:.85; }
  .wordmark-red { color:var(--orange); }
  .masthead h1 { font-size:19px; margin:0; font-weight:600; letter-spacing:-.01em; }
  .live { display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12.5px; }
  .live select { font:inherit; font-size:12px; padding:3px 7px; border-radius:7px;
    border:1px solid rgba(255,255,255,.35); background:rgba(255,255,255,.12); color:#fff; }
  .live select option { color:#101725; }
  .live button { font:inherit; font-size:12px; font-weight:600; padding:3px 10px;
    border-radius:7px; border:1px solid rgba(255,255,255,.35);
    background:rgba(255,255,255,.12); color:#fff; cursor:pointer; }
  .live button:hover { background:rgba(255,255,255,.22); }
  .live-age { opacity:.78; }
  @media print { .live { display:none; } }
  .masthead .meta { font-size:13px; opacity:.78; margin-top:3px; }
  .masthead .right { text-align:right; }

  /* Client card */
  .client { background:var(--card); border:1px solid var(--line); border-radius:16px;
    padding:24px; margin-bottom:22px; box-shadow:0 1px 2px rgba(16,23,37,.04); }
  .client-head { border-bottom:1px solid var(--line); padding-bottom:18px; margin-bottom:20px; }
  .client-head h2 { margin:0 0 10px; font-size:22px; letter-spacing:-.015em; }

  .goal { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;
    background:var(--soft); border-left:3px solid var(--orange); border-radius:0 8px 8px 0;
    padding:9px 14px; margin-bottom:16px; }
  .goal-label { font-size:11px; text-transform:uppercase; letter-spacing:.07em;
    color:var(--muted); }
  .goal-value { font-weight:650; color:var(--navy); }
  .goal-note { font-size:12px; color:var(--muted); }

  .headline, .stats { display:grid; gap:10px; }
  .headline { grid-template-columns:repeat(auto-fit,minmax(196px,1fr)); }
  .stats { grid-template-columns:repeat(auto-fit,minmax(184px,1fr)); margin-bottom:14px; }
  .stat { background:var(--soft); border:1px solid var(--line); border-radius:11px;
    padding:12px 13px; }
  .stat-label { display:block; font-size:11.5px; color:var(--muted);
    text-transform:uppercase; letter-spacing:.05em; }
  .stat-value { display:block; font-size:21px; font-weight:650; margin-top:3px;
    letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
  .stat-sub { display:block; font-size:12px; color:var(--muted); margin-top:1px; }

  /* previous → current */
  .stat-pair { display:flex; align-items:baseline; gap:6px; flex-wrap:nowrap;
    margin-top:3px; white-space:nowrap; }
  .stat-pair .stat-value { margin-top:0; font-size:20px; }
  .stat-prev { font-size:15px; font-weight:600; color:var(--muted); }
  .stat-arrow { font-size:12px; color:var(--muted); opacity:.65; }
  .stat-scale { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
    font-size:10.5px; letter-spacing:.02em; text-transform:uppercase;
    color:var(--muted); opacity:.8; margin-top:3px; }
  .stat-scale .delta { margin-left:0; text-transform:none; letter-spacing:0; }

  /* See more */
  .more { margin:14px 0 0; }
  .more > summary { cursor:pointer; font-size:12.5px; font-weight:600; color:var(--navy);
    list-style:none; display:inline-flex; align-items:center; gap:6px;
    padding:6px 12px; border:1px solid var(--line); border-radius:999px;
    background:var(--soft); }
  .more > summary::-webkit-details-marker { display:none; }
  .more > summary::after { content:'▾'; font-size:11px; }
  .more[open] > summary::after { content:'▴'; }
  .more > summary:hover { border-color:var(--navy); }
  .more .stats { margin-top:12px; }
  @media print { .more { display:block; } .more > summary { display:none; } }
  .delta { display:inline-block; margin-left:7px; padding:1px 7px; border-radius:999px;
    font-size:11.5px; font-weight:650; vertical-align:middle; letter-spacing:.01em; }
  .delta.good { color:#0b6b3a; background:rgba(11,107,58,.10); }
  .delta.bad  { color:#b0141e; background:rgba(176,20,30,.10); }
  .delta.flat { color:var(--muted); background:var(--soft); border:1px solid var(--line); }
  .compare-line { font-size:12.5px; color:var(--muted); margin:6px 0 0; }
  .compare-line.warn-line { color:var(--red); font-weight:600; }
  .crm-note { margin:8px 0 0; font-size:12px; color:var(--muted); }
  .crm-note.warn { color:var(--red); font-weight:600; }
  @media print { .delta { border:1px solid currentColor; background:none; } }
  .stat.accent { border-color:color-mix(in srgb, var(--navy) 35%, var(--line)); }
  .stat.accent .stat-value { color:var(--navy); }
  .stat.win { border-color:color-mix(in srgb, var(--red) 35%, var(--line)); }
  .stat.win .stat-value { color:var(--red); }

  .channel { margin-bottom:28px; }
  .channel:last-child { margin-bottom:0; }
  .channel h3 { font-size:12px; text-transform:uppercase; letter-spacing:.09em;
    color:var(--muted); margin:0 0 12px; padding-bottom:7px;
    border-bottom:1px solid var(--line); }

  .table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:11px; }
  table { border-collapse:collapse; width:100%; font-size:13px; min-width:720px; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line);
    white-space:nowrap; }
  thead th { background:var(--soft); color:var(--muted); font-weight:600; font-size:11.5px;
    text-transform:uppercase; letter-spacing:.05em; }
  tbody tr:last-child td { border-bottom:none; }
  tbody tr:hover td { background:var(--soft); }
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
  td.strong { font-weight:650; color:var(--navy); }
  .parent { display:block; color:var(--muted); font-size:11px; margin-top:2px;
    white-space:normal; }
  .muted { color:var(--muted); }
  .error { color:var(--red); font-size:13px; margin:0; }
  .aside { font-size:12.5px; color:var(--muted); margin:0 0 12px;
    background:var(--soft); border-radius:9px; padding:9px 12px; }
  .warn { color:var(--red); }

  /* Trend charts */
  .trend { margin:18px 0; }
  .trend h4 { font-size:11px; text-transform:uppercase; letter-spacing:.08em;
    color:var(--muted); margin:0 0 10px; font-weight:700; }
  .trend-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(268px,1fr));
    gap:14px; }
  .trend-chart { background:var(--soft); border:1px solid var(--line);
    border-radius:11px; padding:12px 14px 10px; margin:0; }
  .trend-chart-head { display:flex; align-items:baseline; justify-content:space-between;
    gap:8px; margin-bottom:4px; flex-wrap:wrap; }
  .trend-chart-title { font-size:12px; font-weight:650; color:var(--ink); }
  .chart-delta { font-size:10.5px; color:var(--muted); }
  .chart-plot { position:relative; }
  .chart-svg { width:100%; height:150px; display:block; overflow:visible;
    touch-action:pan-y; }
  .chart-svg:focus-visible { outline:2px solid var(--navy); outline-offset:2px; border-radius:4px; }
  .chart-grid { stroke:var(--line); stroke-width:1; }
  .chart-baseline { stroke:var(--muted); opacity:.5; stroke-width:1; }
  .chart-axis { font-size:9.5px; fill:var(--muted); font-variant-numeric:tabular-nums; }
  .chart-endlabel { font-size:10.5px; fill:var(--ink); font-weight:650;
    font-variant-numeric:tabular-nums; }
  .chart-empty { color:var(--muted); font-size:12.5px; margin:0; padding:16px 0; }
  .chart-legend { display:flex; gap:12px; margin-bottom:4px; flex-wrap:wrap; }
  .chart-legend-item { display:inline-flex; align-items:center; gap:6px;
    font-size:11px; color:var(--muted); }
  .chart-key { width:12px; height:2.5px; border-radius:2px; display:inline-block; }
  .chart-table { margin-top:12px; }
  .trend-note { font-size:12px; line-height:1.55; color:var(--muted); margin:12px 0 0;
    background:var(--soft); border:1px solid var(--line); border-left:3px solid var(--orange);
    border-radius:0 9px 9px 0; padding:10px 13px; }
  .trend-note strong { color:var(--ink); }
  .trend-note em { font-style:normal; font-weight:650; color:var(--ink); }

  /* Hover readout */
  .chart-cursor { opacity:0; transition:opacity .08s ease; }
  .chart-cursor.on { opacity:1; }
  .chart-crosshair { stroke:var(--muted); stroke-width:1; opacity:.55; }
  .chart-tip { position:absolute; top:0; z-index:5; pointer-events:none;
    background:var(--card); border:1px solid var(--line); border-radius:8px;
    padding:6px 9px; font-size:11.5px; line-height:1.5;
    box-shadow:0 6px 18px -6px rgba(16,23,37,.28); min-width:78px; }
  .chart-tip[hidden] { display:none; }
  .chart-tip-date { color:var(--muted); font-size:10.5px; margin-bottom:2px; }
  .chart-tip-row { display:flex; align-items:center; gap:6px; white-space:nowrap; }
  .chart-tip-row strong { font-variant-numeric:tabular-nums; color:var(--ink); }
  .chart-tip-row span { color:var(--muted); font-size:10.5px; }
  .chart-tip-key { width:10px; height:2.5px; border-radius:2px; display:inline-block; flex:none; }

  .bars { margin-bottom:14px; }
  .bar-row { display:grid; grid-template-columns:160px 1fr 48px; align-items:center;
    gap:10px; margin-bottom:6px; font-size:13px; }
  .bar { background:var(--soft); border-radius:6px; height:9px; overflow:hidden;
    border:1px solid var(--line); }
  .bar-fill { display:block; height:100%;
    background:linear-gradient(90deg,var(--navy),var(--orange)); }
  .bar-value { text-align:right; font-variant-numeric:tabular-nums; color:var(--muted); }

  .foot { text-align:center; color:var(--muted); font-size:12px; margin-top:26px; }

  /* CRM status funnel */
  .statuses { border:1px solid var(--line); border-radius:11px; padding:13px 15px;
    margin-bottom:14px; background:var(--soft); }
  .statuses-head { display:flex; justify-content:space-between; align-items:baseline;
    font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
    margin-bottom:9px; }
  .status-bar { display:flex; height:12px; border-radius:6px; overflow:hidden;
    background:var(--line); margin-bottom:10px; }
  .seg { display:block; height:100%; }
  /* One colour per stage, all distinct. Sequenced from won to worthless so the bar
     reads left to right as the pipeline drains. */
  .stage-closed { background:#0b6b3a; }
  .stage-qualified { background:var(--navy); }
  .stage-inprogress { background:var(--orange); }
  .stage-noresponse { background:#9aa6c2; }
  .stage-notqualified { background:#c9d0e0; }
  .stage-junk { background:var(--red); }
  .stage-new { background:#5dcaa5; }
  .stage-repeated { background:#8a93ab; }
  .stage-cancelled { background:#b07d2a; }
  .stage-unmapped { background:#6b3fa0; }
  .status-legend { display:flex; flex-wrap:wrap; gap:6px 16px; font-size:12.5px; }
  .legend-item { display:inline-flex; align-items:center; gap:5px; }
  .dot { width:9px; height:9px; border-radius:3px; display:inline-block; }

  /* Navigation */
  .nav { position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:8px;
    background:var(--card); border-bottom:1px solid var(--line); padding:8px 20px; }
  .nav button, .nav-home { background:var(--soft); border:1px solid var(--line);
    color:var(--ink); border-radius:8px; padding:6px 13px; font:inherit; font-size:13px;
    cursor:pointer; text-decoration:none; display:inline-block; }
  .nav button:hover, .nav-home:hover { border-color:var(--navy); color:var(--navy); }
  .nav-home { font-weight:600; }
  .nav-spacer { flex:1; }

  /* What this block totals up */
  .sources { display:flex; flex-wrap:wrap; gap:8px 16px; margin:0 0 14px; align-items:center; }
  .src { display:inline-flex; align-items:center; gap:7px; font-size:12.5px; color:var(--muted); }
  .src-dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:none; }
  .src-dot.meta { background:var(--chart-meta); }
  .src-dot.google { background:var(--chart-google); }
  .src-scope { color:var(--muted); opacity:.75; }
  .src-note { width:100%; margin:2px 0 0; font-size:12px; color:var(--muted);
    border-left:3px solid var(--orange); padding-left:9px; }

  /* Internal-only sections (never in the client copy) */
  .internal-tag { font-size:10px; font-weight:700; text-transform:uppercase;
    letter-spacing:.08em; color:var(--orange); border:1px solid var(--orange);
    border-radius:20px; padding:2px 8px; margin-left:9px; vertical-align:middle; }

  /* Account funds */
  .bal-alarm { margin:0 0 12px; font-weight:650; color:var(--red); font-size:14px; }
  .bal-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
  .bal { border:1px solid var(--line); border-left-width:4px; border-radius:0 11px 11px 0;
    padding:13px 16px; background:var(--soft); }
  .bal.ok { border-left-color:var(--line); }
  .bal.low { border-left-color:var(--orange); }
  .bal.empty { border-left-color:var(--red); }
  .bal-head { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
  .bal-name { font-weight:600; font-size:13.5px; }
  .bal-amount { font-weight:700; font-size:17px; font-variant-numeric:tabular-nums; }
  .bal.low .bal-amount { color:var(--orange); }
  .bal.empty .bal-amount { color:var(--red); }
  .bal-sub { margin:4px 0 0; font-size:12.5px; color:var(--muted); }

  /* Optimisation */
  .insights .finding { border:1px solid var(--line); border-left-width:4px;
    border-radius:0 11px 11px 0; padding:13px 16px; margin-bottom:10px;
    background:var(--soft); }
  .finding.critical { border-left-color:var(--red); }
  .finding.high { border-left-color:var(--orange); }
  .finding.medium { border-left-color:var(--navy); }
  .finding.info { border-left-color:var(--line); }
  .finding-head { display:flex; align-items:center; gap:9px; margin-bottom:5px;
    flex-wrap:wrap; }
  .finding-title { font-weight:650; }
  .chip { font-size:10.5px; text-transform:uppercase; letter-spacing:.06em;
    padding:2px 8px; border-radius:20px; color:#fff; background:var(--muted); }
  .chip.critical { background:var(--red); }
  .chip.high { background:var(--orange); color:#3a2400; }
  .chip.medium { background:var(--navy); }
  .chip.info { background:var(--muted); }
  .finding-detail, .finding-action { margin:0 0 4px; font-size:13.5px; }
  .finding-action { color:var(--muted); }
  .finding-action strong { color:var(--ink); }

  .projection { border:1px solid var(--line); border-radius:12px; padding:16px;
    margin-top:14px; background:var(--card); }
  .projection h4 { margin:0 0 12px; font-size:14px; }
  .proj-grid { display:grid; grid-template-columns:1fr auto 1fr; gap:10px 16px;
    align-items:center; margin-bottom:12px; }
  .proj-label { display:block; font-size:11px; text-transform:uppercase;
    letter-spacing:.05em; color:var(--muted); }
  .proj-now, .proj-next { font-size:22px; font-weight:650; font-variant-numeric:tabular-nums; }
  .proj-next { color:var(--navy); }
  .proj-arrow { color:var(--orange); font-size:20px; text-align:center; }
  .proj-headline { margin:0 0 10px; font-weight:600; color:var(--navy); font-size:14px; }
  details summary { cursor:pointer; font-size:12.5px; color:var(--muted); }
  details ul { margin:8px 0 0; padding-left:18px; font-size:12.5px; color:var(--muted); }
  details li { margin-bottom:4px; }
  .proj-caveat { font-size:12px; color:var(--muted); margin:8px 0 0; font-style:italic; }

  @media print {
    body { background:#fff; }
    .nav { display:none; }
    details { display:block; }
    details > summary { display:none; }
    .masthead { background:var(--navy) !important; -webkit-print-color-adjust:exact;
      print-color-adjust:exact; }
    .client { break-inside:avoid; box-shadow:none; }
  }
</style>
</head><body>
  <nav class="nav">
    <button onclick="history.back()" title="Back">←&nbsp; Back</button>
    <button onclick="history.forward()" title="Forward">Forward &nbsp;→</button>
    <a class="nav-home" href="http://localhost:4321/">Dashboard</a>
    <span class="nav-spacer"></span>
    <button onclick="window.print()">Print / PDF</button>
  </nav>
  <div class="masthead"><div class="wrap">
    ${logoMarkup()}
    <div class="right">
      <h1>Ad performance report</h1>
      <div class="meta">${esc(since)} → ${esc(until)} · generated ${esc(generatedAt)}</div>
      ${live ? LIVE_CONTROL : ''}
    </div>
  </div></div>
  <div class="wrap">
    ${clients.map((c) => clientBlock(c, { internal })).join('')}
    <p class="foot">Leads are Meta lead-form submissions. Qualified and closed come from your CRM's
      status sync where that reaches Meta, and otherwise from your lead sheet — they are credited to
      the date of the ad that produced the lead, not the date the status was set.</p>
  </div>
${CHART_SCRIPT}
</body></html>`;
}
