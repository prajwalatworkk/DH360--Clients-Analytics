// Lead rows from a Google Sheet, served as JSON by the Apps Script web app
// (see apps-script/report-endpoint.gs — deploy it and paste the /exec URL into clients.json).
//
// This is where lead QUALITY comes from. Meta can tell you a form was submitted; only
// your team knows whether that lead was junk, qualified, or actually closed. The Sheet's
// Status column carries that, and the Campaign column ties it back to what paid for it.

// Anything not recognised as qualified/closed counts as a plain lead.
const QUALIFIED = /^(qualified|hot|interested|mql|sql)$/i;
const CLOSED = /^(closed|won|converted|closed.?won|sale|customer)$/i;
const JUNK = /^(junk|spam|invalid|not.?interested|lost|unqualified)$/i;

function classify(status) {
  const s = String(status || '').trim();
  if (CLOSED.test(s)) return 'closed';
  if (QUALIFIED.test(s)) return 'qualified';
  if (JUNK.test(s)) return 'junk';
  return 'new';
}

export async function fetchLeads(client, { since, until }) {
  const endpoint = client.sheet?.endpoint;
  if (!endpoint) return null;

  const url = new URL(endpoint);
  url.searchParams.set('mode', 'report');
  if (process.env.SHEETS_KEY) url.searchParams.set('key', process.env.SHEETS_KEY);
  if (client.sheet.tab) url.searchParams.set('tab', client.sheet.tab);
  url.searchParams.set('since', since);
  url.searchParams.set('until', until);

  let body;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) return { error: `Sheet endpoint returned ${res.status}` };
    body = JSON.parse(text);
  } catch (e) {
    return { error: `Sheet endpoint unreachable or not returning JSON (${e.message})` };
  }
  if (body.error) return { error: body.error };

  const rows = body.rows || [];
  const tsKey = client.sheet.timestampColumn || 'Timestamp';
  const statusKey = client.sheet.statusColumn || 'Status';
  const campaignKey = client.sheet.campaignColumn || 'Campaign';

  // Every row, pre-classified. scopeLeads() rebuilds the counts from these when
  // the user picked a subset of campaigns, so the Sheet totals describe the same
  // campaigns as the ad data beside them rather than the whole tab.
  const classified = [];

  const perDay = {};
  const bySource = {};
  const byCampaign = {};
  // Some clients' landing pages log the Google Ads {campaignid} ValueTrack
  // value (a raw numeric ID) into the Campaign column instead of a human
  // name. applyLeadQuality() checks this index FIRST, since an ID is an
  // exact, unambiguous match — the name-based index below is the fallback
  // for clients whose sheets record a typed campaign name instead.
  const byCampaignId = {};
  const tally = { total: 0, qualified: 0, closed: 0, junk: 0 };

  for (const row of rows) {
    const day = String(row[tsKey] || '').slice(0, 10);
    if (day) perDay[day] = (perDay[day] || 0) + 1;

    const source = row.Source || row.source || 'Unknown';
    bySource[source] = (bySource[source] || 0) + 1;

    const bucket = classify(row[statusKey]);
    tally.total += 1;
    if (bucket !== 'new') tally[bucket] += 1;

    // Campaign names are typed by humans — match forgivingly.
    const campaign = String(row[campaignKey] || '').trim();
    const key = campaign.toLowerCase();
    if (!byCampaign[key]) {
      byCampaign[key] = { campaign, total: 0, qualified: 0, closed: 0, junk: 0 };
    }
    byCampaign[key].total += 1;
    if (bucket !== 'new') byCampaign[key][bucket] += 1;

    classified.push({ day, source, bucket, campaign, key, row });

    // Same row, indexed again by raw ID if the value looks numeric — a
    // campaign named e.g. "2026" would otherwise collide with an ID.
    if (campaign && /^\d+$/.test(campaign)) {
      if (!byCampaignId[campaign]) {
        byCampaignId[campaign] = { campaign, total: 0, qualified: 0, closed: 0, junk: 0 };
      }
      byCampaignId[campaign].total += 1;
      if (bucket !== 'new') byCampaignId[campaign][bucket] += 1;
    }
  }

  const hasStatusColumn = (body.columns || []).some(
    (c) => c.toLowerCase() === statusKey.toLowerCase(),
  );

  return {
    classified,
    count: rows.length,
    perDay,
    bySource,
    byCampaign,
    byCampaignId,
    tally,
    hasStatusColumn,
    statusColumn: statusKey,
    columns: body.columns || Object.keys(rows[0] || {}),
    rows: rows.slice(-50).reverse(),
  };
}

// Does this Sheet row's Campaign value refer to this ad row? Exact ID match first —
// unambiguous, and required for landing pages that log the {campaignid} ValueTrack
// number instead of a typed name. Then exact name, then a contains-match so
// "Lead Gen \u2013 July" still finds "Lead Gen".
//
// The contains-match needs a floor: without one a two-letter Sheet entry matches
// every campaign in the account, which is how one client's Sheet totals end up
// printed against another platform's campaigns.
const MIN_FUZZY = 4;

export function campaignKeyOf(adRow) {
  const name = adRow.campaignName || adRow.name;
  return name ? String(name).trim().toLowerCase() : null;
}

export function sheetMatches(adRow, sheetKey, sheetCampaign) {
  if (adRow.id != null && sheetCampaign && String(sheetCampaign) === String(adRow.id)) return true;
  const key = campaignKeyOf(adRow);
  if (!key || !sheetKey) return false;
  if (sheetKey === key) return true;
  if (sheetKey.length < MIN_FUZZY || key.length < MIN_FUZZY) return false;
  return sheetKey.includes(key) || key.includes(sheetKey);
}

// Restrict a Sheet's counts to the campaigns the user actually selected. Called
// whenever the selection is a subset of an account: without it the report shows
// campaign-level ad numbers next to account-wide Sheet numbers, and the two
// disagree for reasons nothing on the page explains.
export function scopeLeads(leads, adRows) {
  if (!leads || leads.error || !leads.classified) return leads;

  const kept = leads.classified.filter((c) => adRows.some((r) => sheetMatches(r, c.key, c.campaign)));

  const perDay = {};
  const bySource = {};
  const byCampaign = {};
  const byCampaignId = {};
  const tally = { total: 0, qualified: 0, closed: 0, junk: 0 };

  for (const c of kept) {
    if (c.day) perDay[c.day] = (perDay[c.day] || 0) + 1;
    bySource[c.source] = (bySource[c.source] || 0) + 1;
    tally.total += 1;
    if (c.bucket !== 'new') tally[c.bucket] += 1;

    for (const [index, k] of [[byCampaign, c.key], [byCampaignId, c.campaign]]) {
      if (index === byCampaignId && !/^\d+$/.test(c.campaign || '')) continue;
      if (!index[k]) index[k] = { campaign: c.campaign, total: 0, qualified: 0, closed: 0, junk: 0 };
      index[k].total += 1;
      if (c.bucket !== 'new') index[k][c.bucket] += 1;
    }
  }

  return {
    ...leads,
    classified: kept,
    count: kept.length,
    perDay,
    bySource,
    byCampaign,
    byCampaignId,
    tally,
    scoped: true,
    rows: kept.slice(-50).reverse().map((c) => c.row),
  };
}

// Attach Sheet-derived qualified/closed counts to the ad rows they came from.
export function applyLeadQuality(channel, leads) {
  if (!channel || channel.error || !leads || leads.error || !leads.byCampaign) return channel;

  const nameIndex = leads.byCampaign;
  const lookup = (row) => {
    const hit = Object.keys(nameIndex).find((k) => sheetMatches(row, k, nameIndex[k].campaign));
    return hit != null ? nameIndex[hit] : null;
  };

  // The Sheet only knows which CAMPAIGN a lead came from. At adset or ad level a
  // campaign's counts therefore match several rows at once, and attaching them to
  // each one would multiply the totals by the number of rows. Give them to the
  // first (highest-spend) row of each campaign and leave the siblings blank.
  const claimed = new Set();

  for (const row of channel.campaigns) {
    // Statuses synced back to Meta from the client's CRM are already on the row and
    // are the more direct source — the Sheet only fills gaps.
    if (row.hasCrm) continue;
    const match = lookup(row);
    if (!match) continue;
    if (claimed.has(match)) continue;
    claimed.add(match);
    row.qualified = match.qualified;
    row.closed = match.closed;
    row.sheetLeads = match.total;
  }

  return channel;
}
