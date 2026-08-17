# ClientReports

Open the app → see every ad account you run → pick a date range → download the report.

```bash
cd ~/Desktop/ClientReports && npm start
```

That opens http://localhost:4321. The account list is **discovered live** from your Meta
and Google Ads credentials, so adding a new client means giving your login access to their
account — nothing to edit here.

The report is a single self-contained HTML file: no server needed to view it, and ⌘P gives
a clean PDF to send the client. There's also a CSV button for raw campaign rows. Every
generated report is also kept in `reports/`.

### Preview is yours; Download is the client's

**Preview report** and **Download** produce two deliberately different files:

| | Preview | Download |
|---|---|---|
| Performance, leads, CRM statuses | ✓ | ✓ |
| **Optimisation** findings + projections | ✓ | — |
| **Account funds** balance + runway | ✓ | — |

Anything marked **internal** in the preview is stripped from the download, so the file you
send a client has no budget critique and no billing information in it. The two are saved
separately as `report-<dates>-internal.html` and `report-<dates>-client.html`.

### Low-balance warning

Ad accounts stop delivering the moment they run out of money, usually with no notice.
**Meta accounts show their balance** in the dashboard, next to the account name — and the
badge changes colour when it needs attention:

| Badge | Meaning |
|---|---|
| grey `₹8,748` | healthy |
| amber `₹1,240` | under `LOW_BALANCE_THRESHOLD` (default ₹2,000, set in `.env`) |
| red `out of funds` | at zero — ads are not running |

The preview report repeats this per platform with the balance and roughly how many days
it lasts at that account's current burn rate.

**Meta is automatic.** The figure is the account's own "Available balance", the same number
Ads Manager shows. Meta's `spend_cap − amount_spent` is *not* used — it lags behind top-ups.
`balance` is ignored too: on a postpay account it means the amount owed, the opposite of
what's available.

**Google needs one number from you, then tracks itself.** Google's API does not expose
"Available funds" — that figure is *payments − net cost* and lives in Google Payments.
(`account_budget` is not a substitute: it describes one budget *period*, and read ₹8,083.35
against a true ₹9,538.35 on a live account.) So the balance is **anchored**:

1. Open **Google Ads → Billing** and read **Available funds**.
2. In the dashboard, switch to **Google Ads**, open the account list, and tap the balance
   badge (it says `set balance` until you do).
3. Enter the amount.

From then on the app subtracts that account's **real spend from the Google Ads API** each
day, so the number moves on its own. Spend is the only thing that changes the balance
between top-ups, so it stays close. Re-tap the badge to update it after you add funds —
hovering shows what you set and how much has been spent since.

The server runs on your Mac and your credentials never leave it — nothing gets uploaded
to a third party. It listens on every network interface (not just `127.0.0.1`) so it's
reachable from your phone over Tailscale or your home WiFi; set `DASHBOARD_PASSWORD` in
`.env` any time it's reachable beyond `localhost`, or anyone on that network can open it.
See **"Using it from your phone"** below.

### Using it from your phone

1. Install [Tailscale](https://tailscale.com/download) on your Mac and on your phone,
   and sign into both with the same account. This gives your Mac a private address
   (`100.x.x.x`) that only your own devices can reach — nothing is exposed publicly.
2. Set `DASHBOARD_PASSWORD` in `.env` (already set by default after this setup).
3. On your Mac, find the Tailscale IP: click the Tailscale menu bar icon → your device
   name shows a `100.x.x.x` address.
4. On your phone, open `http://100.x.x.x:4321` in Safari (Mac must be on and `npm start`
   running). Enter any username and the `DASHBOARD_PASSWORD` when prompted.
5. Tap the Share icon → **Add to Home Screen**. It opens full-screen with its own icon,
   no Safari address bar — same as a native app.

### Picking exactly what goes in the report

- **Whole account** — tick the account checkbox.
- **Specific campaigns** — click **Campaigns ▾** on that account, tick the ones you want.
  Picking any campaign auto-selects the account and narrows it to your choice; **None**
  clears back to the whole account. Paused campaigns are listed too, labelled.
- **Depth** — *Break down by* switches the report's rows between **Campaign**, **Ad set**
  and **Each ad**. On Google Ads that maps to campaign / ad group / ad.

### Grouping one client across both platforms

If a client runs on Meta *and* Google, select both accounts and they merge into one block
when the account names match. To force a merge under a nicer label (and to attach that
client's website leads), add an entry to `clients.json` — see below.

## Command line

The CLI still works if you'd rather skip the UI:

```bash
node index.js                              # last 30 days, all clients
node index.js --days 7                     # last 7 days
node index.js --client BizStartify         # one client only
node index.js --since 2026-07-01 --until 2026-07-31
node index.js --no-open                    # just write the file
```

Any source that isn't configured is skipped; any source that errors shows the reason
inline in the report instead of killing the run.

## Setup

### 1. Clients (optional)

Accounts are auto-discovered, so `clients.json` is only needed to give a client a custom
label or to attach its website-lead Sheet. Match on the account ID:

```json
{
  "name": "BizStartify",
  "meta":      { "adAccountId": "act_123456789012345" },
  "googleAds": { "customerId": "1234567890" },
  "sheet":     { "endpoint": "https://script.google.com/macros/s/.../exec",
                 "tab": "Landing page lead" }
}
```

### 2. Meta Ads — you need a Meta developer app first

The Meta app exists only to issue the token this dashboard reads with. Nothing is public,
nothing gets reviewed if you stay on your own Business Manager.

1. **developers.facebook.com → My Apps → Create App → type: Business.** Name it anything
   (e.g. "BizStartify Reporting").
2. In the app, **add the Marketing API** product.
3. Link the app to your **Business Manager** (App settings → Basic → Business Account).
4. **business.facebook.com → Business settings → Users → System users → Add.** Give it the
   *Employee* role.
5. On that system user: **Add assets → Ad accounts →** select each client's ad account,
   grant **View performance** (that's `ads_read`).
6. **Generate new token** → pick your app → tick `ads_read` (add `ads_management` only if
   you later want to change campaigns). System user tokens don't expire.
7. Paste it into `.env` as `META_ACCESS_TOKEN`.

Clients must have added your Business Manager as a partner on their ad account — that's
the usual blocker, and it's on their side.

Once the app exists, the Meta Developer MCP can inspect its permissions, rate limits and
API-version runway for you.

### 3. Google Ads

1. Google Ads manager account → **Tools → API Center** → get your **developer token**
   (basic access is enough for reporting).
2. Google Cloud Console → **Credentials → OAuth client ID → Desktop app**. Note the
   client ID and secret.
3. Generate a refresh token once with that client (Google's OAuth playground or the
   `google-ads` quickstart), scope `https://www.googleapis.com/auth/adwords`.
4. Fill `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, and
   `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (your MCC ID, digits only) in `.env`.

Fill `.env` yourself — these are live credentials and shouldn't be pasted into a chat.

### 3b. Your logo

Save the Digital Hub 360 logo as **`assets/logo.png`** (or `.svg` / `.jpg`). It's embedded
into every report automatically. Without one, the report shows a text wordmark.

### 4. Sheet leads — and lead quality

This is where **qualified** and **closed** come from. Meta only knows a form was submitted;
whether that lead was any good is your team's judgement, so it lives in the client's Sheet.

Add two columns to each client's lead tab:

| Column | Values | Purpose |
|---|---|---|
| `Status` | `New` · `Qualified` · `Closed` · `Junk` | Drives qualified / closed counts |
| `Campaign` | the Meta campaign name | Ties each lead back to what paid for it |

Status matching is case-insensitive and accepts synonyms — `Won`, `Converted`, `Sale` all
count as closed; `Hot`, `Interested`, `MQL`, `SQL` count as qualified. Campaign names match
loosely, so "Lead Gen – July" still matches a sheet row saying "Lead Gen".

With those in place the report adds **cost per lead**, **cost per qualified lead** and
**cost per closure**, per campaign. Without the `Status` column it just says so and shows
plain lead counts.

### 4b. Wiring the Sheet up

Copy `apps-script/report-endpoint.gs` into the **same** Apps Script project that already
receives your landing-page leads, then **Deploy → Manage deployments → ✏️ → Version: New
version** (same URL). Your existing `doPost` is untouched.

Two gotchas from the BizStartify script, both already handled here:
- editing the code does **not** update the live `/exec` — you must publish a new version;
- the file declares no global variables, so it can't collide with the lead-capture script.

Paste the `/exec` URL into each client's `sheet.endpoint`.

## Files

| Path | What it is |
|---|---|
| `server.js` | The dashboard — account list, date range, download |
| `public/index.html` | Dashboard UI (self-contained) |
| `src/discover.js` | Lists every ad account your credentials can see |
| `src/campaigns.js` | Lists the campaigns inside one account, for the drill-down |
| `src/csv.js` | Flat CSV export |
| `index.js` | CLI entry — parses args, fetches, writes the report |
| `src/meta.js` | Meta Marketing API insights, campaign level |
| `src/googleAds.js` | Google Ads REST `searchStream` + OAuth refresh |
| `src/sheets.js` | Lead rows from the Apps Script JSON endpoint |
| `src/render.js` | HTML report template (light + dark, print-friendly) |
| `apps-script/report-endpoint.gs` | The `doGet` to add to your Sheet's script |
| `.env` | Your credentials. Never commit or share. |
| `clients.json` | Your client → account ID mapping. |

## Adding a client

Give your Meta system user access to their ad account (or link their Google Ads account to
your manager account). They appear in the dashboard on next load — no code change.
