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

// Read one mapped tab and tally it. Returns null when the campaign has no mapping.
export async function fetchCampaignSheet(mapping, endpoint, { since, until }) {
  if (!mapping || !endpoint) return null;

  const url = new URL(endpoint);
  url.searchParams.set('mode', 'tab');
  url.searchParams.set('ssId', mapping.ssId);
  url.searchParams.set('gid', mapping.gid);
  url.searchParams.set('since', since);
  url.searchParams.set('until', until);
  if (mapping.dateColumn) url.searchParams.set('dateColumn', mapping.dateColumn);

  let body;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) return { error: `CRM sheet returned ${res.status}` };
    body = JSON.parse(text);
  } catch (e) {
    return { error: `CRM sheet unreachable (${e.message})` };
  }
  if (body.error) return { error: body.error };

  // An Apps Script that predates the per-campaign feature answers anything it does
  // not recognise with its own health response, which has no `columns` at all. Say
  // what is actually wrong rather than reporting a tab with no status column.
  if (!Array.isArray(body.columns)) {
    return {
      error: 'That Apps Script is out of date \u2014 it does not understand tab links yet. '
        + 'Paste the new apps-script/report-endpoint.gs into the project and deploy a NEW version.',
    };
  }

  const columns = body.columns;
  const statusKey = statusColumnOf(columns, mapping.statusColumn);
  if (!statusKey) {
    return { error: `No status column in that tab. Headers: ${columns.slice(0, 8).join(', ')}` };
  }

  const tally = {
    total: 0, newEnquiry: 0, qualified: 0, notQualified: 0, closed: 0,
    junk: 0, noResponse: 0, followUp: 0, other: 0, blank: 0,
  };
  const statuses = {};

  for (const row of body.rows || []) {
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
    tab: body.tab || null,
    dateColumn: body.dateColumn || null,
    rows: (body.rows || []).slice(-50).reverse(),
    hasSheet: true,
  };
}
