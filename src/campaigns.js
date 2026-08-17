// Lists the campaigns inside one ad account, so you can pick individual campaigns
// rather than reporting on the whole account.

import { accessToken, API_VERSION as GADS_VERSION } from './googleAds.js';

export async function listMetaCampaigns(accountId) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { error: 'META_ACCESS_TOKEN is not set in .env' };

  const version = process.env.META_API_VERSION || 'v21.0';
  const url = new URL(`https://graph.facebook.com/${version}/${accountId}/campaigns`);
  url.searchParams.set('fields', 'id,name,effective_status,objective');
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', token);

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) return { error: body?.error?.message || `Meta API returned ${res.status}` };

  const campaigns = (body.data || []).map((c) => ({
    id: c.id,
    name: c.name,
    status: c.effective_status || null,
    active: c.effective_status === 'ACTIVE',
  }));
  campaigns.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  return { campaigns };
}

export async function listGoogleCampaigns(customerId) {
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

  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers['login-customer-id'] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '');
  }

  const query = `
    SELECT campaign.id, campaign.name, campaign.status
    FROM campaign
    ORDER BY campaign.name
  `;
  const res = await fetch(
    `https://googleads.googleapis.com/${GADS_VERSION}/customers/${customerId.replace(/-/g, '')}/googleAds:searchStream`,
    { method: 'POST', headers, body: JSON.stringify({ query }) },
  );
  const body = await res.json();
  if (!res.ok) {
    const msg = Array.isArray(body) ? body[0]?.error?.message : body?.error?.message;
    return { error: msg || `Google Ads API returned ${res.status}` };
  }

  const rows = (Array.isArray(body) ? body : [body]).flatMap((c) => c.results || []);
  const campaigns = rows.map((r) => ({
    id: String(r.campaign?.id),
    name: r.campaign?.name || '(unnamed)',
    status: r.campaign?.status || null,
    active: r.campaign?.status === 'ENABLED',
  }));
  campaigns.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  return { campaigns };
}
