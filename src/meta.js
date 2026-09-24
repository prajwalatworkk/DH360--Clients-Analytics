// Meta Ads insights via the Marketing API.

const METRIC_FIELDS = ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'actions', 'conversions'];

// What each breakdown level asks Meta for, and how a row is labelled.
const LEVELS = {
  campaign: { level: 'campaign', fields: ['campaign_id', 'campaign_name'], label: (r) => r.campaign_name },
  adset: {
    level: 'adset',
    fields: ['campaign_id', 'campaign_name', 'adset_name'],
    label: (r) => r.adset_name,
    parent: (r) => r.campaign_name,
  },
  ad: {
    level: 'ad',
    fields: ['campaign_id', 'campaign_name', 'adset_name', 'ad_name'],
    label: (r) => r.ad_name,
    parent: (r) => `${r.campaign_name} › ${r.adset_name}`,
  },
};

// Meta reports several different things all called "conversions", and its `lead`
// aggregate silently mixes them. What each one actually means:
//
//   onsite_conversion.lead_grouped   a real person submitted a Meta lead form
//   offsite_conversion.fb_pixel_lead the website pixel fired a Lead event
//   onsite_conversion.messaging_*    someone started a WhatsApp/Messenger chat
//
// The pixel figure is only as trustworthy as the client's pixel setup, and a
// misconfigured one (firing on page load) inflates it into the tens of thousands.
// So we count Meta form leads as THE lead number, and keep pixel events in a
// separate column rather than folding them together.
const value = (actions, type) => Number(actions.find((a) => a.action_type === type)?.value || 0);

function signalsFromActions(actions = []) {
  return {
    leads: value(actions, 'onsite_conversion.lead_grouped'),
    pixelLeads: value(actions, 'offsite_conversion.fb_pixel_lead'),
    messaging: value(actions, 'onsite_conversion.messaging_conversation_started_7d'),
  };
}

// Lead quality that the client's CRM sends back to Meta arrives on the `conversions`
// field as custom conversions named after the status ("…fb_pixel_custom.qualified").
// These are the team's own judgement of each lead, so they are the truth about quality —
// they just have to be read off a different field than the ad metrics.
const CRM_PREFIX = 'offsite_conversion.fb_pixel_custom.';

const BUCKETS = [
  ['closed', /^(closed|won|converted|sale|hired)$/],
  ['qualified', /^(qualified|hot|interested|mql|sql)$/],
  ['disqualified', /^(not qualified|unqualified|disqualified)$/],
  ['junk', /^(junk|spam|invalid)$/],
  ['unreached', /^(rnr|no response|not reachable|ringing no response)$/],
];

function bucketFor(status) {
  for (const [name, pattern] of BUCKETS) if (pattern.test(status)) return name;
  return 'inProgress';
}

function crmFromConversions(conversions = []) {
  const statuses = {};
  const tally = {
    qualified: 0, closed: 0, junk: 0, disqualified: 0, unreached: 0, inProgress: 0,
  };
  let any = false;

  for (const c of conversions) {
    if (!c.action_type?.startsWith(CRM_PREFIX)) continue;
    const raw = c.action_type.slice(CRM_PREFIX.length);
    // "Not Qualified", "not qualified" and "not_qualified" are one status.
    const status = raw.trim().toLowerCase().replace(/[_\s]+/g, ' ');
    const n = Number(c.value || 0);
    statuses[status] = (statuses[status] || 0) + n;
    tally[bucketFor(status)] += n;
    any = true;
  }

  if (!any) return {};
  const crmTotal = Object.values(statuses).reduce((s, n) => s + n, 0);
  return { ...tally, statuses, crmTotal, hasCrm: true };
}

export async function fetchMeta(client, { since, until }, level = 'campaign') {
  const accountId = client.meta?.adAccountId;
  if (!accountId) return null;

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { error: 'META_ACCESS_TOKEN is not set in .env' };

  const spec = LEVELS[level] || LEVELS.campaign;
  const version = process.env.META_API_VERSION || 'v21.0';
  const url = new URL(`https://graph.facebook.com/${version}/${accountId}/insights`);
  url.searchParams.set('fields', [...spec.fields, ...METRIC_FIELDS].join(','));
  url.searchParams.set('level', spec.level);
  url.searchParams.set('time_range', JSON.stringify({ since, until }));
  url.searchParams.set('limit', '500');
  // Only these campaigns, when the user picked a subset in the UI.
  const only = client.meta?.campaignIds;
  if (only?.length) {
    url.searchParams.set(
      'filtering',
      JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: only }]),
    );
  }
  url.searchParams.set('access_token', token);

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    return { error: body?.error?.message || `Meta API returned ${res.status}` };
  }

  const campaigns = (body.data || []).map((row) => ({
    name: spec.label(row),
    parent: spec.parent ? spec.parent(row) : null,
    campaignName: row.campaign_name || null,
    campaignId: row.campaign_id != null ? String(row.campaign_id) : null,
    spend: Number(row.spend || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    ctr: Number(row.ctr || 0),
    cpc: Number(row.cpc || 0),
    ...signalsFromActions(row.actions),
    ...crmFromConversions(row.conversions),
  }));
  campaigns.sort((a, b) => b.spend - a.spend);

  return { campaigns, totals: totalsOf(campaigns), level };
}

// Day-by-day spend and leads for the report's trend charts. A separate, lighter
// call (account-level, no breakdown) rather than adding time_increment to the
// campaign-level call above — that would turn every campaign row into N daily
// rows and break the campaign table this function already returns.
export async function fetchMetaDaily(client, { since, until }) {
  const accountId = client.meta?.adAccountId;
  if (!accountId) return [];

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return [];

  const version = process.env.META_API_VERSION || 'v21.0';
  const url = new URL(`https://graph.facebook.com/${version}/${accountId}/insights`);
  // `conversions` carries the CRM statuses, so qualified/closed get a daily line too.
  url.searchParams.set('fields', 'spend,actions,conversions');
  url.searchParams.set('time_range', JSON.stringify({ since, until }));
  url.searchParams.set('time_increment', '1');
  url.searchParams.set('limit', '500');
  const only = client.meta?.campaignIds;
  if (only?.length) {
    url.searchParams.set(
      'filtering',
      JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: only }]),
    );
  }
  url.searchParams.set('access_token', token);

  try {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) return [];
    return (body.data || [])
      .map((row) => {
        const crm = crmFromConversions(row.conversions);
        return {
          date: row.date_start,
          spend: Number(row.spend || 0),
          leads: value(row.actions || [], 'onsite_conversion.lead_grouped'),
          // undefined (not 0) when this account syncs no CRM statuses at all — the
          // chart layer uses that to hide the quality charts rather than draw a
          // flat zero line that looks like "no qualified leads".
          qualified: crm.hasCrm ? crm.qualified : undefined,
          closed: crm.hasCrm ? crm.closed : undefined,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

const add = (a, b) => (a || 0) + (b || 0);

export function totalsOf(campaigns) {
  const t = campaigns.reduce(
    (acc, c) => ({
      spend: add(acc.spend, c.spend),
      impressions: add(acc.impressions, c.impressions),
      clicks: add(acc.clicks, c.clicks),
      leads: add(acc.leads, c.leads),
      pixelLeads: add(acc.pixelLeads, c.pixelLeads),
      messaging: add(acc.messaging, c.messaging),
      qualified: add(acc.qualified, c.qualified),
      closed: add(acc.closed, c.closed),
      junk: add(acc.junk, c.junk),
      disqualified: add(acc.disqualified, c.disqualified),
      unreached: add(acc.unreached, c.unreached),
      inProgress: add(acc.inProgress, c.inProgress),
      crmTotal: add(acc.crmTotal, c.crmTotal),
    }),
    {
      spend: 0, impressions: 0, clicks: 0, leads: 0, pixelLeads: 0, messaging: 0,
      qualified: 0, closed: 0, junk: 0, disqualified: 0, unreached: 0,
      inProgress: 0, crmTotal: 0,
    },
  );
  t.hasCrm = campaigns.some((c) => c.hasCrm);
  t.fromSheet = campaigns.some((c) => c.crmSource === 'sheet');
  // Whether quality is *known* for this channel, as opposed to being zero. A real
  // zero ("nothing closed yet") must not read as "no data", or a fallback source
  // gets substituted for it and reports a number that belongs to something else.
  t.hasQualityData = campaigns.some((c) => c.qualified != null || c.closed != null);
  // Merge every campaign's status breakdown into one account-level view.
  t.statuses = {};
  for (const c of campaigns) {
    for (const [status, n] of Object.entries(c.statuses || {})) {
      t.statuses[status] = (t.statuses[status] || 0) + n;
    }
  }
  return withRates(t);
}

// Derived costs live in one place so the table, the totals and the CSV can never
// disagree about how cost per qualified lead is calculated.
export function withRates(t) {
  t.ctr = t.impressions ? (t.clicks / t.impressions) * 100 : 0;
  t.cpc = t.clicks ? t.spend / t.clicks : 0;
  t.cpl = t.leads ? t.spend / t.leads : 0;
  t.cpql = t.qualified ? t.spend / t.qualified : 0;
  t.cpClosure = t.closed ? t.spend / t.closed : 0;
  t.qualifyRate = t.leads ? (t.qualified / t.leads) * 100 : 0;
  t.closeRate = t.qualified ? (t.closed / t.qualified) * 100 : 0;
  return t;
}
