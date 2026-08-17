// Google Ads balances, tracked the only way that can be accurate.
//
// Google's API does not expose "Available funds" — that figure is payments minus net
// cost and lives in Google Payments. `account_budget` is not a substitute: it describes
// one budget period and read ₹8,083.35 against a real ₹9,538.35 on a live account.
//
// So the balance is anchored, not guessed: you enter what the billing page says, and
// from then on it is reduced by Google's own reported spend, which the API *does* give
// accurately. Spend is the only thing that moves the number between top-ups, so it
// tracks closely — and every reading carries the date it was anchored, so a stale
// figure is visible as stale rather than passed off as live.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';

const FILE = path.join(ROOT, 'data', 'balances.json');

export function readStore() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeAnchor(key, amount, asOf) {
  const store = readStore();
  store[key] = { amount: Number(amount), asOf };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2) + '\n');
  return store[key];
}

export function clearAnchor(key) {
  const store = readStore();
  delete store[key];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2) + '\n');
}

// Spend on the anchor day itself is already reflected in the figure you typed in, so
// the burn-down starts the day after.
export function dayAfter(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DEFAULT_THRESHOLD = 2000;
export function threshold() {
  const raw = Number(process.env.LOW_BALANCE_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD;
}

export function remainingFrom(anchor, spentSince, currency = 'INR') {
  const available = Math.max(anchor.amount - (spentSince || 0), 0);
  const t = threshold();
  return {
    available,
    currency,
    threshold: t,
    low: available < t,
    empty: available <= 0,
    anchoredAt: anchor.asOf,
    spentSince: spentSince || 0,
    source: 'anchored',
  };
}
