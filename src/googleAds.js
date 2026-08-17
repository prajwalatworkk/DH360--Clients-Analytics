// Google Ads campaign performance via the Google Ads REST API (searchStream).
import { totalsOf } from './meta.js';

export const API_VERSION = 'v22';

export async function accessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || 'OAuth token refresh failed');
  return body.access_token;
}

// Google Ads' equivalent of Meta's campaign / adset / ad levels.
const LEVELS = {
  campaign: {
    from: 'campaign',
    select: ['campaign.id', 'campaign.name'],
    label: (r) => r.campaign?.name || '(unnamed)',
    // The lead sheet only ever records which CAMPAIGN a click came from
    // (from the utm_campaign / {campaignid} ValueTrack param), so ID
    // matching is only meaningful at this level.
    id: (r) => r.campaign?.id != null ? String(r.campaign.id) : null,
  },
  adset: {
    from: 'ad_group',
    select: ['campaign.id', 'campaign.name', 'ad_group.name'],
    label: (r) => r.adGroup?.name || '(unnamed)',
    parent: (r) => r.campaign?.name,
  },
  ad: {
    from: 'ad_group_ad',
    select: ['campaign.id', 'campaign.name', 'ad_group.name', 'ad_group_ad.ad.name', 'ad_group_ad.ad.id'],
    label: (r) => r.adGroupAd?.ad?.name || `Ad ${r.adGroupAd?.ad?.id || ''}`.trim(),
    parent: (r) => `${r.campaign?.name} › ${r.adGroup?.name}`,
  },
};

export async function fetchGoogleAds(client, { since, until }, level = 'campaign') {
  const customerId = client.googleAds?.customerId?.replace(/-/g, '');
  if (!customerId) return null;

  const missing = [
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
  ].filter((k) => !process.env[k]);
  if (missing.length) return { error: `Missing in .env: ${missing.join(', ')}` };

  let token;
  try {
    token = await accessToken();
  } catch (e) {
    return { error: e.message };
  }

  const spec = LEVELS[level] || LEVELS.campaign;
  const only = (client.googleAds?.campaignIds || []).filter((id) => /^\d+$/.test(id));
  const campaignFilter = only.length ? `AND campaign.id IN (${only.join(',')})` : '';
  const query = `
    SELECT ${spec.select.join(', ')},
           metrics.cost_micros,
           metrics.impressions,
           metrics.clicks,
           metrics.conversions
    FROM ${spec.from}
    WHERE segments.date BETWEEN '${since}' AND '${until}'
      AND metrics.impressions > 0
      ${campaignFilter}
    ORDER BY metrics.cost_micros DESC
  `;

  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers['login-customer-id'] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '');
  }

  const res = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`,
    { method: 'POST', headers, body: JSON.stringify({ query }) },
  );
  const body = await res.json();
  if (!res.ok) {
    const msg = Array.isArray(body) ? body[0]?.error?.message : body?.error?.message;
    return { error: msg || `Google Ads API returned ${res.status}` };
  }

  const rows = (Array.isArray(body) ? body : [body]).flatMap((chunk) => chunk.results || []);
  const campaigns = rows.map((r) => {
    const spend = Number(r.metrics?.costMicros || 0) / 1e6;
    const impressions = Number(r.metrics?.impressions || 0);
    const clicks = Number(r.metrics?.clicks || 0);
    return {
      name: spec.label(r),
      id: spec.id ? spec.id(r) : null,
      parent: spec.parent ? spec.parent(r) : null,
      spend,
      impressions,
      clicks,
      ctr: impressions ? (clicks / impressions) * 100 : 0,
      cpc: clicks ? spend / clicks : 0,
      leads: Number(r.metrics?.conversions || 0),
    };
  });

  return { campaigns, totals: totalsOf(campaigns), level };
}

// Day-by-day spend and leads for the report's trend charts. Grouped by campaign
// as well as date because GAQL has no server-side SUM — same-day rows across the
// matching campaigns are added together here.
export async function fetchGoogleAdsDaily(client, { since, until }) {
  const customerId = client.googleAds?.customerId?.replace(/-/g, '');
  if (!customerId) return [];

  const missing = [
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
  ].filter((k) => !process.env[k]);
  if (missing.length) return [];

  let token;
  try {
    token = await accessToken();
  } catch {
    return [];
  }

  const only = (client.googleAds?.campaignIds || []).filter((id) => /^\d+$/.test(id));
  const campaignFilter = only.length ? `AND campaign.id IN (${only.join(',')})` : '';
  const query = `
    SELECT segments.date, metrics.cost_micros, metrics.conversions
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
      ${campaignFilter}
  `;

  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers['login-customer-id'] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '');
  }

  try {
    const res = await fetch(
      `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`,
      { method: 'POST', headers, body: JSON.stringify({ query }) },
    );
    if (!res.ok) return [];
    const body = await res.json();
    const rows = (Array.isArray(body) ? body : [body]).flatMap((c) => c.results || []);

    const byDate = new Map();
    for (const r of rows) {
      const date = r.segments.date;
      const entry = byDate.get(date) || { date, spend: 0, leads: 0 };
      entry.spend += Number(r.metrics?.costMicros || 0) / 1e6;
      entry.leads += Number(r.metrics?.conversions || 0);
      byDate.set(date, entry);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}
