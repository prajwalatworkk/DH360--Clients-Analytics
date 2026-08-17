// Auto-discovers every ad account the logged-in credentials can actually see,
// so you never hand-maintain a client list.

import { accessToken, API_VERSION as GADS_VERSION } from './googleAds.js';
import { balanceOf, paceOf } from './balance.js';
import { readStore, remainingFrom, dayAfter, todayLocal } from './manualBalance.js';

// Google's Ads API has no field for "money left in the account" — verified by trying
// the candidates: `payments_account` and `invoice` aren't queryable for a
// manual-payment account, and `account_budget` describes one budget *period*, not the
// wallet (it read ₹8,083.35 against a real ₹9,538.35 on a live account, because the
// budget record started partway through the account's life). There is no live number
// to fetch here, on this or any Google Ads integration — the figure lives in Google
// Payments, outside the API entirely.
//
// So each account gets whichever of these is available, cheapest-and-most-honest first:
//
//   1. An anchor you set once from the billing page, burned down by real spend since.
//      Accurate until something other than spend changes it (a top-up, a refund).
//   2. A pace check, fully automatic: today's spend against this account's own recent
//      average. A funds problem's one unmistakable symptom is delivery collapsing to
//      near-zero — this catches that live, every time, with nothing to type in.
async function attachGoogleBalances(accounts, headers) {
  const store = readStore();
  const today = todayLocal();

  await Promise.all(
    accounts.map(async (account) => {
      const anchor = store[`google:${account.id}`];
      if (anchor?.asOf && Number.isFinite(Number(anchor.amount))) {
        await attachAnchoredBalance(account, anchor, headers, today);
      } else {
        await attachPace(account, headers, today);
      }
    }),
  );
  return accounts;
}

async function costBetween(customerId, from, to, headers) {
  const query = `
    SELECT segments.date, metrics.cost_micros
    FROM customer
    WHERE segments.date BETWEEN '${from}' AND '${to}'
  `;
  const res = await fetch(
    `https://googleads.googleapis.com/${GADS_VERSION}/customers/${customerId}/googleAds:searchStream`,
    { method: 'POST', headers, body: JSON.stringify({ query }) },
  );
  if (!res.ok) return [];
  const body = await res.json();
  return (Array.isArray(body) ? body : [body])
    .flatMap((c) => c.results || [])
    .map((r) => ({ date: r.segments.date, cost: Number(r.metrics?.costMicros || 0) / 1e6 }));
}

async function attachAnchoredBalance(account, anchor, headers, today) {
  const from = dayAfter(anchor.asOf);
  // Anchored today: nothing has been spent since, so no query is needed.
  if (from > today) {
    account.balance = remainingFrom(anchor, 0, account.currency);
    return;
  }
  try {
    const rows = await costBetween(account.id, from, today, headers);
    const spent = rows.reduce((s, r) => s + r.cost, 0);
    account.balance = remainingFrom(anchor, spent, account.currency);
  } catch {
    // Leave this account without a balance rather than failing discovery.
  }
}

async function attachPace(account, headers, today) {
  try {
    // 9 days ending yesterday — today is excluded deliberately (see paceOf: a partial
    // day always looks like a drop).
    const from = shiftDate(today, -9);
    const yesterday = shiftDate(today, -1);
    const rows = await costBetween(account.id, from, yesterday, headers);
    account.pace = paceOf(rows.sort((a, b) => a.date.localeCompare(b.date)));
  } catch {
    // No pace signal for this account rather than failing discovery.
  }
}

function shiftDate(iso, deltaDays) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function discoverMeta() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { accounts: [], error: 'META_ACCESS_TOKEN is not set in .env' };

  const version = process.env.META_API_VERSION || 'v21.0';
  const url = new URL(`https://graph.facebook.com/${version}/me/adaccounts`);
  // Keep to fields ads_read covers — `business` would require business_management.
  // The funding fields are what tell us a prepaid account is about to run dry.
  url.searchParams.set(
    'fields',
    'account_id,name,currency,account_status,amount_spent,spend_cap,is_prepay_account,' +
      'funding_source_details{display_string,type}',
  );
  url.searchParams.set('limit', '200');
  url.searchParams.set('access_token', token);

  try {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) {
      return { accounts: [], error: body?.error?.message || `Meta API returned ${res.status}` };
    }
    const accounts = (body.data || []).map((a) => ({
      platform: 'meta',
      id: `act_${a.account_id}`,
      name: a.name || `act_${a.account_id}`,
      currency: a.currency,
      // 1 = active; anything else is disabled/closed/pending and usually returns no data.
      active: a.account_status === 1,
      balance: balanceOf(a),
    }));
    accounts.sort((a, b) => a.name.localeCompare(b.name));
    return { accounts };
  } catch (e) {
    return { accounts: [], error: e.message };
  }
}

export async function discoverGoogleAds() {
  const missing = [
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
  ].filter((k) => !process.env[k]);
  if (missing.length) return { accounts: [], error: `Missing in .env: ${missing.join(', ')}` };

  let token;
  try {
    token = await accessToken();
  } catch (e) {
    return { accounts: [], error: e.message };
  }

  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const mcc = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, '');
  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': devToken,
    'Content-Type': 'application/json',
  };
  if (mcc) headers['login-customer-id'] = mcc;

  try {
    // With a manager account we get every child account and its real name in one query.
    if (mcc) {
      const query = `
        SELECT customer_client.id,
               customer_client.descriptive_name,
               customer_client.currency_code,
               customer_client.manager,
               customer_client.status
        FROM customer_client
        WHERE customer_client.status = 'ENABLED'
      `;
      const res = await fetch(
        `https://googleads.googleapis.com/${GADS_VERSION}/customers/${mcc}/googleAds:searchStream`,
        { method: 'POST', headers, body: JSON.stringify({ query }) },
      );
      const body = await res.json();
      if (!res.ok) {
        const msg = Array.isArray(body) ? body[0]?.error?.message : body?.error?.message;
        return { accounts: [], error: msg || `Google Ads API returned ${res.status}` };
      }
      const rows = (Array.isArray(body) ? body : [body]).flatMap((c) => c.results || []);
      const accounts = rows
        .map((r) => r.customerClient)
        // Manager accounts hold no campaigns of their own — reporting on them is empty.
        .filter((c) => c && !c.manager)
        .map((c) => ({
          platform: 'google',
          id: String(c.id),
          name: c.descriptiveName || String(c.id),
          currency: c.currencyCode,
          active: true,
        }));
      accounts.sort((a, b) => a.name.localeCompare(b.name));
      await attachGoogleBalances(accounts, headers);
      return { accounts };
    }

    // No manager account: fall back to whatever this login can reach directly.
    const res = await fetch(
      `https://googleads.googleapis.com/${GADS_VERSION}/customers:listAccessibleCustomers`,
      { headers },
    );
    const body = await res.json();
    if (!res.ok) {
      return { accounts: [], error: body?.error?.message || `Google Ads API returned ${res.status}` };
    }
    const accounts = (body.resourceNames || []).map((rn) => {
      const id = rn.split('/').pop();
      return { platform: 'google', id, name: `Google Ads ${id}`, active: true };
    });
    await attachGoogleBalances(accounts, headers);
    return { accounts };
  } catch (e) {
    return { accounts: [], error: e.message };
  }
}

export async function discoverAll() {
  const [meta, google] = await Promise.all([discoverMeta(), discoverGoogleAds()]);
  return {
    meta: meta.accounts,
    google: google.accounts,
    errors: [
      meta.error ? { platform: 'meta', message: meta.error } : null,
      google.error ? { platform: 'google', message: google.error } : null,
    ].filter(Boolean),
  };
}
