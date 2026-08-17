// How much money is left in a prepaid ad account, and whether that's about to run out.
//
// Meta exposes this three different ways and they don't always agree:
//
//   funding_source_details.display_string  "Available balance (₹8,776.25 INR)"
//   spend_cap − amount_spent               the prepaid top-up minus what's been billed
//   balance                                amount *owed* (postpay), not what's available
//
// display_string is what Meta shows in Ads Manager, and it picks up a top-up before
// spend_cap does — so that's the number to trust. The subtraction is the fallback for
// accounts where Meta doesn't return a display string. `balance` is never used as
// "available": on a postpay account it means the opposite.

const DEFAULT_THRESHOLD = 2000;

export function lowBalanceThreshold() {
  const raw = Number(process.env.LOW_BALANCE_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD;
}

// "Available balance (₹8,776.25 INR)" -> 8776.25
function amountFromDisplayString(text) {
  if (!text) return null;
  const inside = /\(([^)]*)\)/.exec(String(text));
  if (!inside) return null;
  const digits = /-?[\d,]+(?:\.\d+)?/.exec(inside[1]);
  if (!digits) return null;
  const value = Number(digits[0].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

// Meta returns money as a string in minor units (paise for INR).
const fromMinorUnits = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : null;
};

// `account` is a raw row from /me/adaccounts (or /act_<id>).
export function balanceOf(account) {
  if (!account?.is_prepay_account) return null; // postpay: nothing to run out of

  const shown = amountFromDisplayString(account.funding_source_details?.display_string);
  const cap = fromMinorUnits(account.spend_cap);
  const spent = fromMinorUnits(account.amount_spent);
  const computed = cap != null && spent != null ? Math.max(cap - spent, 0) : null;

  const available = shown ?? computed;
  if (available == null) return null;

  const threshold = lowBalanceThreshold();
  return {
    available,
    currency: account.currency || 'INR',
    threshold,
    low: available < threshold,
    empty: available <= 0,
    // Kept so the report can say where the number came from rather than just asserting it.
    source: shown != null ? 'meta' : 'computed',
  };
}

// Google Ads has no balance to read — see the note in discover.js for why the API
// genuinely cannot answer "how much money is left" for a Google account.
//
// What the API answers reliably is spend, day by day. Running out of funds has one
// unmistakable symptom regardless of platform: delivery drops to near-zero while
// everything else (campaigns, budgets, targeting) is unchanged. This watches for that
// directly, live, off Google's own numbers — no number to type in, nothing to keep
// updated.
//
// `days` is the last ~9 days of {date, cost}, oldest first, NOT including today (a
// partial day always looks like a drop and would cry wolf).
export function paceOf(days = []) {
  const clean = days.filter((d) => Number.isFinite(d.cost));
  const recent = clean.slice(-2); // yesterday and the day before
  const baseline = clean.slice(-7, -2); // the 5 days before that

  if (recent.length < 2 || baseline.length < 3) return null; // not enough history yet

  const avg = (rows) => rows.reduce((s, d) => s + d.cost, 0) / rows.length;
  const baselineAvg = avg(baseline);
  const recentAvg = avg(recent);

  // An account that wasn't really spending has no baseline to fall from — flagging it
  // would just be noise on a paused or dormant account.
  const MEANINGFUL_DAILY_SPEND = 100;
  if (baselineAvg < MEANINGFUL_DAILY_SPEND) return { status: 'quiet' };

  const ratio = recentAvg / baselineAvg;
  const dropped = ratio < 0.2; // delivery collapsed to under a fifth of normal

  return {
    status: dropped ? 'dropped' : 'normal',
    recentAvg,
    baselineAvg,
    droppedPct: dropped ? Math.round((1 - ratio) * 100) : 0,
  };
}

// Days of runway left at the current burn rate, or null when we can't say.
export function runwayDays(available, spend, days) {
  if (!available || !spend || !days) return null;
  const perDay = spend / days;
  if (perDay <= 0) return null;
  return available / perDay;
}
