// One-time helper: turns your OAuth Client ID + Secret into a refresh token and
// writes it straight into .env. Run with `npm run google:auth` after you've created
// a Desktop-app OAuth client in Google Cloud Console and pasted the ID/secret in .env.
//
// This opens Google's own consent screen in your browser — you approve access to
// your Google Ads account there. Nothing here ever sees your Google password.

import http from 'node:http';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv } from '../src/env.js';

loadEnv();

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in .env first.\n' +
    'Create a Desktop-app OAuth client in Google Cloud Console (APIs & Services → Credentials),\n' +
    'paste the two values into .env, then run this again.',
  );
  process.exit(1);
}

const PORT = 8721;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/adwords');
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

function saveRefreshToken(token) {
  const file = path.join(ROOT, '.env');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const key = 'GOOGLE_OAUTH_REFRESH_TOKEN';
  let found = false;
  const next = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) {
      found = true;
      return `${key}=${token}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${token}`);
  fs.writeFileSync(file, next.join('\n'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/') {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      `<p>Google returned an error: ${error}. You can close this tab and try again.</p>`,
    );
    console.error(`Google returned an error: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400).end('Missing code');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' }).end(
    '<p>Connected. You can close this tab and go back to the terminal.</p>',
  );

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const body = await tokenRes.json();
    if (!tokenRes.ok || !body.refresh_token) {
      throw new Error(body.error_description || body.error || 'No refresh token returned');
    }
    saveRefreshToken(body.refresh_token);
    console.log('\nSaved GOOGLE_OAUTH_REFRESH_TOKEN to .env.');
    console.log('Next: add GOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_LOGIN_CUSTOMER_ID, then restart the server.');
  } catch (e) {
    console.error(`\nCould not exchange the code for a token: ${e.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Opening your browser to approve access…\nIf it doesn't open, visit:\n${authUrl}\n`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${opener} "${authUrl}"`);
});
