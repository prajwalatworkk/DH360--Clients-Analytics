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

// Attach Sheet-derived qualified/closed counts to the ad rows they came from.
export function applyLeadQuality(channel, leads) {
  if (!channel || channel.error || !leads || leads.error || !leads.byCampaign) return channel;

  const idIndex = leads.byCampaignId || {};
  const nameIndex = leads.byCampaign;
  const lookup = (row) => {
    // Exact ID match first — unambiguous, and required for landing pages
    // that log the {campaignid} ValueTrack number instead of a typed name.
    if (row.id != null && idIndex[String(row.id)]) return idIndex[String(row.id)];

    const name = row.campaignName || row.name;
    if (!name) return null;
    const key = String(name).trim().toLowerCase();
    if (nameIndex[key]) return nameIndex[key];
    // Fall back to a contains-match so "Lead Gen – July" still finds "Lead Gen".
    const hit = Object.keys(nameIndex).find((k) => k && (k.includes(key) || key.includes(k)));
    return hit ? nameIndex[hit] : null;
  };

  for (const row of channel.campaigns) {
    // Statuses synced back to Meta from the client's CRM are already on the row and
    // are the more direct source — the Sheet only fills gaps.
    if (row.hasCrm) continue;
    const match = lookup(row);
    if (!match) continue;
    row.qualified = match.qualified;
    row.closed = match.closed;
    row.sheetLeads = match.total;
  }

  return channel;
}
