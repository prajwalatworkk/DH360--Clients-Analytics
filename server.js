#!/usr/bin/env node
// Local dashboard: pick accounts, pick a date range, download the report.
// Binds to every interface so it's reachable over Tailscale / your LAN from your
// phone — but everything still runs on your Mac; credentials never go to a
// third-party server. If DASHBOARD_PASSWORD is set in .env, every request must
// carry a valid session cookie (set by /login) before it reaches any route.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { loadEnv, ROOT } from './src/env.js';
import { discoverAll, discoverMeta, discoverGoogleAds } from './src/discover.js';
import { runwayDays } from './src/balance.js';
import { writeAnchor, clearAnchor, todayLocal } from './src/manualBalance.js';
import { listMetaCampaigns, listGoogleCampaigns } from './src/campaigns.js';
import { fetchMeta, fetchMetaDaily } from './src/meta.js';
import { fetchGoogleAds, fetchGoogleAdsDaily } from './src/googleAds.js';
import { fetchLeads, applyLeadQuality, scopeLeads } from './src/sheets.js';
import {
  parseSheetUrl, loadMap, saveMapping, mappingKey, fetchCampaignSheet,
} from './src/campaignSheets.js';
import { fetchMetaGoals } from './src/goals.js';
import { analyse } from './src/insights.js';
import { totalsOf } from './src/meta.js';
import { renderReport } from './src/render.js';
import { toCsv } from './src/csv.js';

loadEnv();
const PORT = Number(process.env.PORT) || 4321;

// Every response here is live ad data. Safari — and an iOS home-screen app in
// particular — will otherwise re-serve a cached copy and quietly show yesterday's
// numbers, so nothing from this server is allowed to be stored.
const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...NO_STORE,
  });
  res.end(payload);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('Request too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Optional: clients.json can attach a Sheet lead endpoint (and a nicer label)
// to a discovered ad account, matched by account id.
function sheetEndpointFor(accountId) {
  return sheetConfigFor(accountId)?.sheet?.endpoint || null;
}

function sheetConfigFor(accountId) {
  const file = path.join(ROOT, 'clients.json');
  if (!fs.existsSync(file)) return null;
  try {
    const clients = JSON.parse(fs.readFileSync(file, 'utf8'));
    const match = clients.find(
      (c) => c.meta?.adAccountId === accountId || c.googleAds?.customerId === accountId,
    );
    return match ? { name: match.name, sheet: match.sheet } : null;
  } catch {
    return null;
  }
}

const daysBetween = (since, until) =>
  Math.max(Math.round((Date.parse(until) - Date.parse(since)) / 86400000) + 1, 1);

const shiftDate = (iso, deltaDays) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The window a report is compared against. "previous" is the same number of days
// immediately before the report; a number is that many days immediately before it.
// Either way it ends the day before the report starts, so the two never overlap.
function compareRange({ since, until }, compare) {
  if (!compare || compare === 'none') return null;
  const days = compare === 'previous' ? daysBetween(since, until) : Number(compare);
  if (!Number.isInteger(days) || days < 1 || days > 366) return null;
  const prevUntil = shiftDate(since, -1);
  return { since: shiftDate(prevUntil, -(days - 1)), until: prevUntil, days };
}

// Balances are only needed for the internal copy, so this costs nothing on a
// client download. Keyed by "<platform>:<id>" because a Meta account id and a
// Google customer id are different namespaces.
async function accountBalances() {
  const [meta, google] = await Promise.all([
    discoverMeta().catch(() => ({ accounts: [] })),
    discoverGoogleAds().catch(() => ({ accounts: [] })),
  ]);
  const map = new Map();
  for (const a of [...(meta.accounts || []), ...(google.accounts || [])]) {
    if (a.balance || a.pace) map.set(`${a.platform}:${a.id}`, a);
  }
  return map;
}

async function buildReport({ accounts, since, until, level, internal = false, light = false }) {
  // Group the selected accounts by client label so one client with both platforms
  // renders as a single block.
  const groups = new Map();
  for (const account of accounts) {
    const linked = sheetConfigFor(account.id);
    const label = linked?.name || account.name;
    if (!groups.has(label)) {
      groups.set(label, {
        name: label, meta: null, googleAds: null, sheet: linked?.sheet || null,
        // What was actually picked, so the report can say so outright. Two accounts
        // from different platforms merge into one client block, and without this the
        // headline totals look inexplicable — they are a sum across both.
        sources: [],
      });
    }
    const group = groups.get(label);
    // campaignIds empty/absent means "the whole account".
    const campaignIds = account.campaignIds || [];
    group.sources.push({
      platform: account.platform === 'meta' ? 'Meta Ads' : 'Google Ads',
      account: account.name,
      campaignCount: campaignIds.length,
    });
    if (account.platform === 'meta') group.meta = { adAccountId: account.id, campaignIds };
    else group.googleAds = { customerId: account.id, campaignIds };
  }

  const range = { since, until };
  const balances = internal && !light ? await accountBalances() : new Map();
  const spanDays = daysBetween(since, until);
  const results = [];
  for (const group of groups.values()) {
    const [meta, googleAds, leads, goals, metaDaily, googleDaily] = await Promise.all([
      fetchMeta(group, range, level).catch((e) => ({ error: e.message })),
      fetchGoogleAds(group, range, level).catch((e) => ({ error: e.message })),
      fetchLeads(group, range).catch((e) => ({ error: e.message })),
      group.meta && !light
        ? fetchMetaGoals(group.meta.adAccountId, group.meta.campaignIds).catch(() => null)
        : null,
      light ? [] : fetchMetaDaily(group, range).catch(() => []),
      light ? [] : fetchGoogleAdsDaily(group, range).catch(() => []),
    ]);

    // When the user narrowed to specific campaigns, the Sheet has to be narrowed the
    // same way. It is keyed by campaign, but it is fetched for the whole tab — left
    // unscoped, a one-campaign report prints account-wide Sheet totals beside
    // one-campaign ad numbers, and nothing on the page explains the mismatch.
    const selectedIds = [
      ...(group.meta?.campaignIds || []),
      ...(group.googleAds?.campaignIds || []),
    ];
    let scopedLeads = leads;
    if (selectedIds.length) {
      const adRows = selectedIds.map((id) => ({ id, campaignName: null }));
      for (const channel of [meta, googleAds]) {
        if (!channel || channel.error) continue;
        for (const row of channel.campaigns) {
          adRows.push({ id: null, campaignName: row.campaignName || row.name });
        }
      }
      scopedLeads = scopeLeads(leads, adRows);
    }

    // Lead quality lives in the Sheet, so it is folded in after the ad data arrives
    // and the totals are recomputed to include it.
    for (const channel of [meta, googleAds]) {
      if (!channel || channel.error) continue;
      applyLeadQuality(channel, scopedLeads);
    }

    // A campaign mapped to its own CRM tab overrides everything above. That tab is
    // what the sales team actually updates, so it outranks both the account-wide
    // sheet and the statuses the CRM syncs back into Meta — those go stale, and a
    // campaign the team keeps current should not be second-guessed by them.
    const sheetMap = loadMap();
    const endpoint = group.sheet?.endpoint || process.env.SHEETS_ENDPOINT || null;
    const crmErrors = [];
    for (const [channel, platform, accountId] of [
      [meta, 'meta', group.meta?.adAccountId],
      [googleAds, 'google', group.googleAds?.customerId],
    ]) {
      if (!channel || channel.error || !accountId) continue;
      const ids = [...new Set(channel.campaigns.map((r) => r.campaignId).filter(Boolean))];
      const mapped = ids
        .map((id) => [id, sheetMap[mappingKey(platform, accountId, id)]])
        .filter(([, m]) => m);
      if (!mapped.length) continue;

      const fetched = await Promise.all(
        mapped.map(async ([id, m]) => [id, await fetchCampaignSheet(m, endpoint, range), m]),
      );

      for (const [id, tally, m] of fetched) {
        if (!tally) continue;
        if (tally.error) {
          crmErrors.push({ campaign: m.campaignName || id, message: tally.error });
          continue;
        }
        // At adset/ad level several rows share one campaign, and one campaign's tab
        // must be counted once — give it to the first row and blank the siblings.
        let first = true;
        for (const row of channel.campaigns) {
          if (row.campaignId !== id) continue;
          if (!first) {
            row.qualified = null; row.closed = null;
            row.hasCrm = false; row.statuses = {};
            row.junk = 0; row.disqualified = 0; row.unreached = 0;
            row.inProgress = 0; row.crmTotal = 0;
            continue;
          }
          first = false;
          row.qualified = tally.qualified;
          row.closed = tally.closed;
          row.junk = tally.junk;
          row.disqualified = tally.notQualified;
          row.unreached = tally.noResponse;
          row.inProgress = tally.followUp;
          row.crmTotal = tally.total;
          row.statuses = tally.statuses;
          row.sheetLeads = tally.total;
          row.hasCrm = true;
          row.crmSource = 'sheet';
          row.crmTab = tally.tab;
        }
      }
    }

    for (const channel of [meta, googleAds]) {
      if (!channel || channel.error) continue;
      channel.totals = totalsOf(channel.campaigns);
    }

    const client = {
      name: group.name, meta, googleAds, leads: scopedLeads, goals, metaDaily, googleDaily,
      sources: group.sources, crmErrors,
    };
    client.insights = light ? null : analyse(client);

    // Runway is measured per platform against that platform's own spend over the
    // same window, so "days left" reflects how fast this account actually burns.
    client.balances = [
      group.meta && ['Meta Ads', `meta:${group.meta.adAccountId}`, meta?.totals?.spend],
      group.googleAds && [
        'Google Ads',
        `google:${group.googleAds.customerId}`,
        googleAds?.totals?.spend,
      ],
    ]
      .filter(Boolean)
      .map(([platform, key, spend]) => {
        const funded = balances.get(key);
        if (!funded) return null;
        if (funded.balance) {
          return {
            account: funded.name,
            platform,
            ...funded.balance,
            runwayDays: runwayDays(funded.balance.available, spend, spanDays),
          };
        }
        if (funded.pace) {
          return { account: funded.name, platform, pace: funded.pace };
        }
        return null;
      })
      .filter(Boolean);

    results.push(client);
  }
  return results;
}

// Constant-time compare so a valid password can't be guessed via response timing.
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a || '');
  const bufB = Buffer.from(b || '');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// The session cookie is an HMAC of the password itself — no server-side session
// store needed, and every cookie invalidates automatically if the password changes.
// iOS home-screen web apps don't share Safari's saved HTTP Basic Auth credentials
// (so a Basic Auth prompt reappears every launch); a cookie persists correctly.
const COOKIE_NAME = 'cr_auth';
const COOKIE_MAX_AGE = 180 * 24 * 60 * 60; // 180 days, in seconds

function sessionToken() {
  return crypto.createHmac('sha256', process.env.DASHBOARD_PASSWORD).update('cr-session').digest('hex');
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  if (!process.env.DASHBOARD_PASSWORD) return true; // not gated — e.g. plain localhost use
  return timingSafeStringEqual(parseCookies(req)[COOKIE_NAME], sessionToken());
}

const LOGIN_PAGE = (error) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Client Reports · Login</title>
<meta name="theme-color" content="#FFFFFF">
<style>
  :root {
    color-scheme: light;
    --navy:#0B3C91; --navy-lift:#1450BE; --red:#E31B37; --orange:#F0A020;
    --bg:#F5F7FA; --surface:#fff; --surface-sunken:#F8FAFC; --ink:#0D1420;
    --muted:#7A8699; --line:#E6EAF1; --line-strong:#D4DBE6;
    --shadow:0 14px 36px -10px rgba(13,20,32,.16), 0 4px 10px rgba(13,20,32,.05);
  }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:var(--bg); color:var(--ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  form {
    background:var(--surface); border:1px solid var(--line); border-radius:18px;
    padding:34px 30px; width:100%; max-width:350px; margin:16px; box-shadow:var(--shadow);
    position:relative; overflow:hidden;
  }
  form::before {
    content:''; position:absolute; left:0; right:0; top:0; height:3px;
    background:linear-gradient(90deg, var(--navy) 0%, var(--navy) 34%,
                                      var(--orange) 34%, var(--orange) 67%,
                                      var(--red) 67%, var(--red) 100%);
  }
  .brand { display:flex; align-items:center; gap:13px; margin-bottom:8px; }
  .brand svg { width:48px; height:48px; flex:none; }
  h1 {
    font-size:23px; font-weight:780; line-height:.98; letter-spacing:-.032em;
    margin:0; color:var(--navy);
  }
  h1 span { color:var(--red); }
  .hint { color:var(--muted); font-size:13px; margin:0 0 22px; }
  input {
    width:100%; background:var(--surface-sunken); border:1px solid var(--line-strong);
    color:var(--ink); border-radius:12px; padding:14px 15px; font:inherit; font-size:16px;
    margin-bottom:12px; transition:border-color .15s ease;
  }
  input:focus { outline:none; border-color:var(--navy); box-shadow:0 0 0 3px rgba(11,60,145,.16); }
  button {
    width:100%; background:linear-gradient(180deg, var(--navy-lift) 0%, var(--navy) 100%);
    color:#fff; border:none; border-radius:12px; padding:14px; font:inherit; font-size:15.5px;
    font-weight:650; cursor:pointer; box-shadow:0 6px 16px -5px rgba(11,60,145,.34);
    transition:filter .15s ease, transform .12s ease;
  }
  button:hover { filter:brightness(1.08); }
  button:active { transform:translateY(1px); }
  .error {
    color:#C0392B; font-size:13px; margin:0 0 12px; padding:10px 12px;
    background:rgba(192,57,43,.06); border:1px solid rgba(192,57,43,.22); border-radius:9px;
  }
</style></head>
<body>
  <form method="POST" action="/login">
    <div class="brand">
      <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <path d="M21 40.6 C22 30 26 22 31.2 16.8 C38 21 39.5 30 36 37.8 C31 42 25 42.5 21 40.6 Z" fill="#F0A020"/>
        <circle cx="32" cy="32" r="22" stroke="#0B3C91" stroke-width="8.6"
                stroke-dasharray="38 100.23" transform="rotate(-88 32 32)"/>
        <circle cx="32" cy="32" r="22" stroke="#E31B37" stroke-width="11.8"
                stroke-dasharray="53 85.23" transform="rotate(22 32 32)"/>
        <circle cx="32" cy="32" r="22" stroke="#E31B37" stroke-width="4.6"
                stroke-dasharray="24 114.23" transform="rotate(196 32 32)"/>
      </svg>
      <h1>Digital<br>Hub<span>360</span></h1>
    </div>
    <p class="hint">Client Reports</p>
    ${error ? '<p class="error">Wrong password.</p>' : ''}
    <input type="password" name="password" placeholder="Password" autofocus required>
    <button type="submit">Log in</button>
  </form>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/login') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_PAGE(url.searchParams.get('error')));
    }
    if (req.method === 'POST') {
      const body = await readRawBody(req);
      const given = new URLSearchParams(body).get('password') || '';
      if (!process.env.DASHBOARD_PASSWORD || !timingSafeStringEqual(given, process.env.DASHBOARD_PASSWORD)) {
        res.writeHead(302, { Location: '/login?error=1' });
        return res.end();
      }
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `${COOKIE_NAME}=${sessionToken()}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax`,
      });
      return res.end();
    }
  }

  if (!isAuthed(req)) {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not logged in.' }));
  }

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE });
      return res.end(html);
    }

    // Static assets for the home-screen app (manifest + icons) — a fixed
    // allow-list, not a general file server.
    const STATIC = {
      '/manifest.json': 'application/manifest+json',
      '/icon-180.png': 'image/png',
      '/icon-192.png': 'image/png',
      '/icon-512.png': 'image/png',
    };
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = path.join(ROOT, 'public', url.pathname.slice(1));
      if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': STATIC[url.pathname] });
      return res.end(fs.readFileSync(file));
    }

    // Reopen a previously generated report: /reports/<filename>.html
    if (req.method === 'GET' && url.pathname.startsWith('/reports/')) {
      const name = path.basename(url.pathname);
      const file = path.join(ROOT, 'reports', name);
      if (!name.endsWith('.html') || !fs.existsSync(file)) {
        return json(res, 404, { error: 'No such report.' });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE });
      return res.end(fs.readFileSync(file));
    }

    if (req.method === 'GET' && url.pathname === '/api/reports') {
      const dir = path.join(ROOT, 'reports');
      const files = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.html'))
            .map((f) => ({ name: f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.at - a.at)
            .slice(0, 10)
        : [];
      return json(res, 200, { reports: files });
    }

    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      return json(res, 200, await discoverAll());
    }

    // Anchor a Google Ads balance to what the billing page says. From here the
    // app burns it down using Google's own spend figures.
    if (req.method === 'POST' && url.pathname === '/api/balance') {
      const { platform, id, amount, asOf } = await readBody(req);
      if (platform !== 'google' || !id) {
        return json(res, 400, { error: 'Only Google Ads balances are set here.' });
      }
      if (amount === null || amount === '') {
        clearAnchor(`google:${id}`);
        return json(res, 200, { cleared: true });
      }
      const value = Number(amount);
      if (!Number.isFinite(value) || value < 0) {
        return json(res, 400, { error: 'Amount must be a number.' });
      }
      const date = /^\d{4}-\d{2}-\d{2}$/.test(asOf || '') ? asOf : todayLocal();
      if (date > todayLocal()) {
        return json(res, 400, { error: 'The "as of" date cannot be in the future.' });
      }
      return json(res, 200, { saved: writeAnchor(`google:${id}`, value, date) });
    }

    if (req.method === 'GET' && url.pathname === '/api/campaigns') {
      const platform = url.searchParams.get('platform');
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: 'Missing account id.' });
      const result =
        platform === 'google' ? await listGoogleCampaigns(id) : await listMetaCampaigns(id);
      return json(res, result.error ? 502 : 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/api/campaign-sheet') {
      return json(res, 200, { mappings: loadMap(), hasEndpoint: Boolean(process.env.SHEETS_ENDPOINT) });
    }

    if (req.method === 'POST' && url.pathname === '/api/campaign-sheet') {
      const { platform, accountId, campaignId, campaignName, url: link } = await readBody(req);
      if (!platform || !accountId || !campaignId) {
        return json(res, 400, { error: 'Missing campaign.' });
      }
      const key = mappingKey(platform, accountId, campaignId);

      // An empty link clears the mapping rather than erroring — that is how you
      // unlink a campaign from the UI.
      if (!link || !String(link).trim()) {
        saveMapping(key, null);
        return json(res, 200, { ok: true, cleared: true });
      }

      const parsed = parseSheetUrl(link);
      if (parsed.error) return json(res, 400, { error: parsed.error });

      const mapping = { ...parsed, campaignName: campaignName || null, url: String(link).trim() };

      // Read it once now, so a bad link or an unshared sheet is caught here rather
      // than silently producing an empty column in the next report.
      const endpoint = sheetEndpointFor(accountId) || process.env.SHEETS_ENDPOINT;
      if (!endpoint) {
        return json(res, 400, {
          error: 'No Apps Script endpoint configured. Add SHEETS_ENDPOINT to .env, or a sheet endpoint for this client in clients.json.',
        });
      }
      const today = todayLocal();
      const probe = await fetchCampaignSheet(mapping, endpoint, { since: '2000-01-01', until: today });
      if (probe?.error) return json(res, 400, { error: probe.error });

      saveMapping(key, mapping);
      return json(res, 200, {
        ok: true,
        tab: probe.tab,
        statusColumn: probe.statusColumn,
        dateColumn: probe.dateColumn,
        total: probe.total,
        qualified: probe.qualified,
        closed: probe.closed,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/report') {
      const { accounts = [], since, until, format = 'html', level = 'campaign', compare = 'previous' } =
        await readBody(req);
      if (!accounts.length) return json(res, 400, { error: 'Select at least one account.' });
      if (!['campaign', 'adset', 'ad'].includes(level)) {
        return json(res, 400, { error: 'Breakdown must be campaign, adset or ad.' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        return json(res, 400, { error: 'Dates must be YYYY-MM-DD.' });
      }
      if (since > until) return json(res, 400, { error: 'Start date is after end date.' });

      // Preview is for you and carries the internal sections; a download is the copy
      // that gets sent to the client, so it never includes them.
      const internal = url.searchParams.get('download') === '0';
      const prior = compareRange({ since, until }, compare);
      const [clients, priorClients] = await Promise.all([
        buildReport({ accounts, since, until, level, internal }),
        prior ? buildReport({ accounts, ...prior, level, light: true }) : [],
      ]);
      // Same accounts and selection, so client blocks line up by name.
      if (prior) {
        const byName = new Map(priorClients.map((c) => [c.name, c]));
        for (const c of clients) c.previous = { ...prior, client: byName.get(c.name) || null };
      }
      const stamp = `${since}_to_${until}`;

      if (format === 'csv') {
        const csv = toCsv({ clients, since, until });
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="client-report-${stamp}.csv"`,
        });
        return res.end(csv);
      }

      const html = renderReport({
        clients,
        since,
        until,
        generatedAt: new Date().toLocaleString('en-IN'),
        internal,
      });

      // Keep a copy on disk as well, so past reports are re-openable. Internal and
      // client copies are saved under different names so the two never get mixed up.
      const outDir = path.join(ROOT, 'reports');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, `report-${stamp}${internal ? '-internal' : '-client'}.html`),
        html,
      );

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition':
          url.searchParams.get('download') === '0'
            ? 'inline'
            : `attachment; filename="client-report-${stamp}.html"`,
        ...NO_STORE,
      });
      return res.end(html);
    }

    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const address = `http://localhost:${PORT}`;
  console.log(`ClientReports dashboard → ${address}`);
  if (!process.env.DASHBOARD_PASSWORD) {
    console.log('DASHBOARD_PASSWORD is not set — anyone who can reach this port can open it.');
  }
  if (process.platform === 'darwin' && process.env.NO_OPEN !== '1') execFile('open', [address]);
});
