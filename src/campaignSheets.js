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

  // gid is optional. Paste any link to the spreadsheet and pick the tab from the
  // list the app fetches; a gid in the link only decides which tab starts selected.
  // Requiring it here was a trap: the gid is invisible in the Sheets UI, and the
  // address bar does not always follow the tab you clicked.
  const gid = text.match(/[#?&]gid=(\d+)/);
  return { ssId: id[1], gid: gid ? gid[1] : null };
}

// A tab is linked by gid, which is invisible in the Sheets UI — so the wrong tab
// produces a perfectly valid-looking report with someone else's numbers in it. This
// does not block the save (a team may legitimately name a tab nothing like the
// campaign), it just says plainly what was linked to what.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'phase', 'campaign', 'leads', 'lead', 'ads', 'new',
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

const significantWords = (text) =>
  new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
  );

export function tabMismatch(campaignName, tabName) {
  if (!campaignName || !tabName) return null;
  const a = significantWords(campaignName);
  const b = significantWords(tabName);
  if (!a.size || !b.size) return null;
  for (const w of a) if (b.has(w)) return null;
  return `Heads up: campaign is \u201c${campaignName}\u201d but that tab is \u201c${tabName}\u201d. `
    + 'If that is not the tab you meant, open the right one in Sheets and copy the URL again \u2014 '
    + 'the tab is identified by the gid in the link, which does not change when you switch tabs in the browser.';
}

// Every tab in a spreadsheet, for the picker. Needs the Apps Script (the CSV export
// can fetch a tab but cannot enumerate them).
export async function listTabs(ssId, endpoint) {
  if (!endpoint) return { error: 'No Apps Script endpoint configured.' };
  const url = new URL(endpoint);
  url.searchParams.set('mode', 'tabs');
  if (process.env.SHEETS_KEY) url.searchParams.set('key', process.env.SHEETS_KEY);
  url.searchParams.set('ssId', ssId);
  try {
    const body = await fetchScriptJson(url);
    if (body.error === 'Unauthorised') return { error: 'Wrong or missing key.' };
    if (body.error) return { error: body.error };
    if (!Array.isArray(body.tabs)) {
      return { error: 'That deployment cannot list tabs yet \u2014 redeploy a new version.' };
    }
    return { tabs: body.tabs, spreadsheet: body.spreadsheet };
  } catch (e) {
    return { error: e.message };
  }
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

// Header names a Meta lead export uses. Used to find the header ROW, which is not
// reliably row 1: when a newer export is appended below an older one, the header
// lands in the middle of the tab. Taking row 1 on faith reads a data row as the
// column names, and then every lookup silently returns the wrong column.
const KNOWN_HEADERS = new Set([
  'id', 'created_time', 'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id',
  'campaign_name', 'form_id', 'form_name', 'is_organic', 'platform', 'full_name',
  'phone_number', 'email', 'lead_status', 'status', 'timestamp', 'name', 'phone',
  'source', 'campaign', 'date', 'stage',
]);

function headerRowIndex(values) {
  const limit = Math.min(values.length, 500);
  let best = null;

  for (let i = 0; i < limit; i += 1) {
    let known = 0;
    let filled = 0;
    for (const cell of values[i]) {
      const text = String(cell ?? '').trim();
      if (!text) continue;
      filled += 1;
      if (KNOWN_HEADERS.has(text.toLowerCase())) known += 1;
    }
    if (known < 3) continue;

    // Counting recognised names is not enough on its own: a sheet with a second
    // table beside the first carries that table's header names in every data row,
    // which scores as high as the real header. What separates them is the share of
    // the row that is header names — a header row is almost nothing else, a data row
    // is mostly values.
    const ratio = known / filled;
    if (!best || ratio > best.ratio + 0.05
      || (Math.abs(ratio - best.ratio) <= 0.05 && known > best.known)) {
      best = { index: i, ratio, known };
    }
  }

  return best ? best.index : 0;
}

// Blank and repeated header cells would collapse into one another as object keys,
// taking their columns' data with them.
function uniqueHeaders(row) {
  const seen = new Map();
  return row.map((cell, i) => {
    const name = String(cell || '').trim() || `col_${i}`;
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

function gridToObjects(values) {
  if (!values?.length) return { columns: [], rows: [] };
  const h = headerRowIndex(values);
  const columns = uniqueHeaders(values[h]);
  const rows = [];
  values.forEach((line, i) => {
    if (i === h) return;
    if (line.every((c) => String(c ?? '').trim() === '')) return;
    const obj = {};
    columns.forEach((c, j) => { obj[c] = line[j] == null ? '' : String(line[j]); });
    rows.push(obj);
  });
  return { columns, rows, headerRow: h };
}

const STATUS_HEADERS = ['lead_status', 'status', 'lead status', 'crm status', 'stage'];
const DATE_HEADERS = ['created_time', 'timestamp', 'date', 'created', 'lead_date', 'submitted'];

// Dates in a sheet maintained by hand are not all ISO. A single stray row written
// as "8/28//2026" was being read as undated, which meant it counted inside every
// range — one extra closure in a September report for a lead from August.
export function isoDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const iso = text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;

  // Tolerate repeated or mixed separators: 8/28//2026, 28-8-2026, 8.28.2026
  const parts = text.split(/[^0-9]+/).filter(Boolean);
  if (parts.length < 3) return null;

  const [a, b, c] = parts.map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)) return null;

  let year;
  let first;
  let second;
  if (String(parts[0]).length === 4) [year, first, second] = [a, b, c];
  else if (String(parts[2]).length === 4) [first, second, year] = [a, b, c];
  else return null;
  if (year < 2000 || year > 2100) return null;

  // Which of the two is the month. Only decidable when one of them cannot be one;
  // a genuinely ambiguous pair like 5/6/2026 is left unparsed rather than guessed.
  let month;
  let day;
  if (first > 12 && second <= 12) { day = first; month = second; }
  else if (second > 12 && first <= 12) { month = first; day = second; }
  else return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

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
  return gridToObjects(parseCsv(text));
}

// Apps Script /exec answers with a 302 to script.googleusercontent.com. Google serves
// that redirect differently depending on the request headers: with no User-Agent it
// intermittently returns a 404 HTML page instead of the script's output, which looks
// exactly like a broken deployment. Send a browser-ish UA, and retry once, since the
// failure is intermittent rather than sticky.
async function fetchScriptJson(url, { tries = 2 } = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ClientReports',
          Accept: 'application/json,text/plain,*/*',
        },
      });
      const text = await res.text();
      if (!res.ok) { last = new Error(`Apps Script: returned ${res.status}.`); continue; }
      try {
        return JSON.parse(text);
      } catch {
        last = new Error('Apps Script: did not return JSON (Google served a redirect page).');
      }
    } catch (e) {
      last = new Error(`Apps Script: ${e.message}`);
    }
  }
  throw last;
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

  const body = await fetchScriptJson(url);
  if (body.error === 'Unauthorised') {
    throw new Error('Apps Script: wrong or missing key (set SHEETS_KEY in .env to match DH360_KEY in the script).');
  }
  if (body.error) throw new Error(`Apps Script: ${body.error}`);
  // Newer deployments hand back the raw grid so the header row can be found here.
  if (Array.isArray(body.values)) {
    return { ...gridToObjects(body.values), tab: body.tab };
  }
  if (!Array.isArray(body.columns)) {
    throw new Error('Apps Script: deployment is out of date (redeploy a new version).');
  }
  return { columns: body.columns, rows: body.rows || [], tab: body.tab };
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

  // A general pipeline tab carries several campaigns' leads. Narrow to this one, or
  // the campaign's report shows every campaign that shares the tab.
  const campaignIdKey = columns.find((c) => c.trim().toLowerCase() === 'campaign_id');
  const campaignNameKey = columns.find((c) => c.trim().toLowerCase() === 'campaign_name');
  let scopeNote = null;
  let rows = data.rows || [];

  if (mapping.campaignId && campaignIdKey) {
    // Meta writes the id as "c:120249481815510660" in some exports and bare in others.
    const want = String(mapping.campaignId);
    const hit = rows.filter((r) => String(r[campaignIdKey] || '').replace(/^c:/, '') === want);
    if (hit.length) {
      rows = hit;
      scopeNote = `campaign_id ${want}`;
    } else if (new Set(rows.map((r) => r[campaignIdKey])).size > 1) {
      // The tab holds several campaigns and none of them is this one: counting all of
      // them would be worse than saying so.
      return {
        error: `That tab holds leads for other campaigns, and none for campaign ${want}. `
          + 'Check it is the right tab.',
      };
    }
  } else if (mapping.campaignName && campaignNameKey) {
    const want = String(mapping.campaignName).trim().toLowerCase();
    const hit = rows.filter((r) => String(r[campaignNameKey] || '').trim().toLowerCase() === want);
    if (hit.length) { rows = hit; scopeNote = `campaign_name "${mapping.campaignName}"`; }
  }

  // The CSV export cannot filter by date server-side, so the window is applied here.
  const dateKey = dateColumnOf(columns, mapping.dateColumn);
  let undated = 0;
  const inRange = (row) => {
    if (!dateKey) return true;
    const iso = isoDate(row[dateKey]);
    // A row whose date cannot be read is still a lead, so it is kept rather than
    // silently dropped — but it is counted, because a row that lands in every date
    // range is worth knowing about.
    if (!iso) { undated += 1; return true; }
    return iso >= since && iso <= until;
  };

  const kept = rows.filter(inRange);

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
    scopeNote,
    undated,
    headerRow: data.headerRow ?? 0,
    tabTotal: (data.rows || []).length,
    tab: data.tab || mapping.tabName || null,
    via: data.via,
    rows: kept.slice(-50).reverse(),
    hasSheet: true,
  };
}
