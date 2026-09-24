// Per-campaign CRM tabs.
//
// A campaign's real outcome — who was qualified, who actually closed — lives in a
// tab of a Google Sheet that the sales team keeps up to date. This module maps a
// campaign to exactly one such tab, reads it, and tallies the statuses.
//
// The mapping is stored by campaign id rather than campaign name: names get edited
// in Ads Manager, ids never change. The tab is addressed by gid for the same reason
// — renaming a tab in Sheets does not change its gid, so a pasted link keeps working.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';

const STORE = path.join(ROOT, 'campaign-sheets.json');

// https://docs.google.com/spreadsheets/d/<ssId>/edit?…#gid=<gid>
export function parseSheetUrl(url) {
  const text = String(url || '').trim();
  if (!text) return { error: 'Paste the tab link first.' };

  const id = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!id) return { error: 'That does not look like a Google Sheets link.' };

  // gid can sit in the fragment (#gid=) or the query (?gid=). A link copied from the
  // browser bar while a tab is open has it; one copied from "Share" does not, and
  // defaults to the first tab — which would silently read the wrong campaign.
  const gid = text.match(/[#?&]gid=(\d+)/);
  if (!gid) {
    return {
      error: 'That link has no tab in it. Open the campaign’s tab in Sheets and copy the URL from the address bar.',
    };
  }
  return { ssId: id[1], gid: gid[1] };
}

export function loadMap() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveMapping(key, value) {
  const map = loadMap();
  if (value) map[key] = value;
  else delete map[key];
  fs.writeFileSync(STORE, `${JSON.stringify(map, null, 2)}\n`);
  return map;
}

export const mappingKey = (platform, accountId, campaignId) =>
  `${platform}:${accountId}:${campaignId}`;

// ---------------------------------------------------------------------------
// Status buckets.
//
// The sales team types these by hand, so match forgivingly: case, underscores and
// extra spaces are all normalised away first. "not qualified" must be tested before
// "qualified" or it lands in the wrong bucket and doubles the qualified count.
const BUCKETS = [
  // A lead nobody has worked yet. Its own bucket rather than "other", so it never
  // reads as a judgement the team has not actually made.
  ['newEnquiry', /^(new.?enquiry|new.?inquiry|new.?lead|new|fresh|untouched|not.?contacted|pending|open)$/],
  ['closed', /^(closed|closed.?won|won|converted|sale|sold|customer|hired|booked)$/],
  ['notQualified', /^(not.?qualified|unqualified|disqualified|not.?interested|lost|not.?eligible)$/],
  ['junk', /^(junk|spam|invalid|fake|test|wrong.?number)$/],
  ['noResponse', /^(no.?response|rnr|not.?reachable|ringing.?no.?response|unreachable|no.?answer)$/],
  ['followUp', /^(follow.?up|following.?up|callback|call.?back|in.?progress|warm|nurture)$/],
  ['qualified', /^(qualified|hot|interested|mql|sql|prospect)$/],
];

export function bucketFor(status) {
  const s = String(status || '').trim().toLowerCase().replace(/[_\s]+/g, ' ');
  if (!s) return 'blank';
  for (const [name, pattern] of BUCKETS) if (pattern.test(s)) return name;
  return 'other';
}

const STATUS_HEADERS = ['lead_status', 'status', 'lead status', 'crm status', 'stage'];
const DATE_HEADERS = ['created_time', 'timestamp', 'date', 'created', 'lead_date', 'submitted'];

function dateColumnOf(columns, preferred) {
  if (preferred && columns.includes(preferred)) return preferred;
  const lower = columns.map((c) => String(c).trim().toLowerCase());
  for (const want of DATE_HEADERS) {
    const i = lower.indexOf(want);
    if (i > -1) return columns[i];
  }
  const i = lower.findIndex((c) => c.includes('time') || c.includes('date') || c.includes('stamp'));
  return i > -1 ? columns[i] : null;
}

function statusColumnOf(columns, preferred) {
  if (preferred && columns.includes(preferred)) return preferred;
  const lower = columns.map((c) => String(c).trim().toLowerCase());
  for (const want of STATUS_HEADERS) {
    const i = lower.indexOf(want);
    if (i > -1) return columns[i];
  }
  // Any header that merely contains "status" — covers "Status (2)" and the like.
  const i = lower.findIndex((c) => c.includes('status'));
  return i > -1 ? columns[i] : null;
}

// A tab can be read three ways, tried in order. Apps Script came first but needs a
// redeploy to learn new tricks, which is a bad thing to be blocked on; the direct
// CSV export needs no deployment at all, only that the sheet is link-shared.
//
//   1. Google Sheets API      private, needs a Sheets-scoped OAuth token
//   2. CSV export             no setup, but the sheet must be link-viewable
//   3. Apps Script endpoint   private, but the deployment must be current
//
// Each returns { columns, rows } or throws, so the caller just takes the first that
// works and reports every failure together if none do.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function tableToObjects(table) {
  if (!table.length) return { columns: [], rows: [] };
  const columns = table[0].map((c) => String(c).trim());
  const rows = [];
  for (const line of table.slice(1)) {
    if (line.every((c) => String(c).trim() === '')) continue;
    const obj = {};
    columns.forEach((c, i) => { obj[c] = line[i] == null ? '' : String(line[i]); });
    rows.push(obj);
  }
  return { columns, rows };
}

async function readViaCsv({ ssId, gid }) {
  const url = `https://docs.google.com/spreadsheets/d/${ssId}/export?format=csv&gid=${gid}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'CSV export: sheet or tab not found (check the link is complete).'
        : `CSV export: not link-shared (HTTP ${res.status}).`,
    );
  }
  const text = await res.text();
  // A sign-in page comes back as 200 HTML, not CSV — catch that rather than
  // parsing a login form into lead rows.
  if (/^\s*</.test(text)) throw new Error('CSV export: sheet is private (Google returned a sign-in page).');
  return tableToObjects(parseCsv(text));
}

async function readViaAppsScript({ ssId, gid, dateColumn }, endpoint, { since, until }) {
  if (!endpoint) throw new Error('Apps Script: no endpoint configured.');
  const url = new URL(endpoint);
  url.searchParams.set('mode', 'tab');
  if (process.env.SHEETS_KEY) url.searchParams.set('key', process.env.SHEETS_KEY);
  url.searchParams.set('ssId', ssId);
  url.searchParams.set('gid', gid);
  url.searchParams.set('since', since);
  url.searchParams.set('until', until);
  if (dateColumn) url.searchParams.set('dateColumn', dateColumn);

  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apps Script: returned ${res.status}.`);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('Apps Script: did not return JSON.'); }
  if (body.error === 'Unauthorised') {
    throw new Error('Apps Script: wrong or missing key (set SHEETS_KEY in .env to match DH360_KEY in the script).');
  }
  if (body.error) throw new Error(`Apps Script: ${body.error}`);
  if (!Array.isArray(body.columns)) {
    throw new Error('Apps Script: deployment is out of date (redeploy a new version).');
  }
  return { columns: body.columns, rows: body.rows || [], tab: body.tab, dateColumn: body.dateColumn };
}

// Read one mapped tab and tally it. Returns null when the campaign has no mapping.
export async function fetchCampaignSheet(mapping, endpoint, { since, until }) {
  if (!mapping) return null;

  const attempts = [];
  let data = null;
  for (const [name, run] of [
    ['csv', () => readViaCsv(mapping)],
    ['script', () => readViaAppsScript(mapping, endpoint, { since, until })],
  ]) {
    try {
      data = await run();
      data.via = name;
      break;
    } catch (e) {
      attempts.push(e.message);
    }
  }
  if (!data) {
    return {
      error: `Could not read that tab. ${attempts.join(' ')} `
        + 'Either set the sheet to "Anyone with the link \u2192 Viewer", or redeploy the Apps Script.',
    };
  }

  const columns = data.columns;
  const statusKey = statusColumnOf(columns, mapping.statusColumn);
  if (!statusKey) {
    return { error: `No status column in that tab. Headers: ${columns.slice(0, 8).join(', ')}` };
  }

  const tally = {
    total: 0, newEnquiry: 0, qualified: 0, notQualified: 0, closed: 0,
    junk: 0, noResponse: 0, followUp: 0, other: 0, blank: 0,
  };
  const statuses = {};

  // The CSV export cannot filter by date server-side, so the window is applied here.
  const dateKey = dateColumnOf(columns, mapping.dateColumn);
  const inRange = (row) => {
    if (!dateKey) return true;
    const stamp = String(row[dateKey] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) return true;
    return stamp >= since && stamp <= until;
  };

  const kept = (data.rows || []).filter(inRange);

  for (const row of kept) {
    tally.total += 1;
    const raw = String(row[statusKey] || '').trim();
    tally[bucketFor(raw)] += 1;
    const label = raw || '(blank)';
    statuses[label] = (statuses[label] || 0) + 1;
  }

  return {
    ...tally,
    statuses,
    statusColumn: statusKey,
    dateColumn: dateKey,
    tab: data.tab || mapping.tabName || null,
    via: data.via,
    rows: kept.slice(-50).reverse(),
    hasSheet: true,
  };
}
