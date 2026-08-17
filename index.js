#!/usr/bin/env node
// Pull every client's ad + lead numbers and write one self-contained HTML report.
//
//   node index.js                     last 30 days, all clients
//   node index.js --days 7            last 7 days
//   node index.js --client BizStartify
//   node index.js --since 2026-07-01 --until 2026-07-31
//   node index.js --no-open           don't open the report in the browser

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadEnv, dateRange, ROOT } from './src/env.js';
import { fetchMeta } from './src/meta.js';
import { fetchGoogleAds } from './src/googleAds.js';
import { fetchLeads } from './src/sheets.js';
import { renderReport } from './src/render.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'no-open') args.open = false;
    else args[key] = argv[++i];
  }
  return args;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const configPath = path.join(ROOT, 'clients.json');
  if (!fs.existsSync(configPath)) {
    console.error(
      'No clients.json found. Copy clients.example.json to clients.json and fill in your client IDs.',
    );
    process.exit(1);
  }
  let clients = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  if (args.client) {
    const needle = args.client.toLowerCase();
    clients = clients.filter((c) => c.name.toLowerCase().includes(needle));
    if (!clients.length) {
      console.error(`No client in clients.json matches "${args.client}".`);
      process.exit(1);
    }
  }

  const range =
    args.since && args.until
      ? { since: args.since, until: args.until }
      : dateRange(Number(args.days) || 30);

  console.log(`Pulling ${range.since} → ${range.until} for ${clients.length} client(s)…`);

  const results = [];
  for (const client of clients) {
    process.stdout.write(`  ${client.name} … `);
    const [meta, googleAds, leads] = await Promise.all([
      fetchMeta(client, range).catch((e) => ({ error: e.message })),
      fetchGoogleAds(client, range).catch((e) => ({ error: e.message })),
      fetchLeads(client, range).catch((e) => ({ error: e.message })),
    ]);
    const problems = [meta, googleAds, leads].filter((r) => r?.error).length;
    console.log(problems ? `done (${problems} source(s) errored)` : 'done');
    results.push({ name: client.name, meta, googleAds, leads });
  }

  const html = renderReport({
    clients: results,
    since: range.since,
    until: range.until,
    generatedAt: new Date().toLocaleString('en-IN'),
  });

  const outDir = path.join(ROOT, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `report-${range.since}_to_${range.until}.html`);
  fs.writeFileSync(outFile, html);
  console.log(`\nReport written: ${outFile}`);

  if (args.open !== false && process.platform === 'darwin') {
    execFile('open', [outFile]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
