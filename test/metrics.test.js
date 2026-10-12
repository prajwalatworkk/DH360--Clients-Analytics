import test from 'node:test';
import assert from 'node:assert/strict';
import { changeOf, polarityOf, kindOf } from '../src/metrics.js';

test('polarity: spend is neutral, never coloured good or bad', () => {
  assert.equal(polarityOf('spend'), 'neutral');
  assert.equal(changeOf('spend', 20000, 10000).tone, 'flat');
  assert.equal(changeOf('spend', 10000, 20000).tone, 'flat');
});

test('polarity: cost per lead rising is bad, falling is good', () => {
  assert.equal(changeOf('costPerLead', 400, 200).tone, 'bad');
  assert.equal(changeOf('costPerLead', 200, 400).tone, 'good');
});

test('polarity: leads rising is good, falling is bad', () => {
  assert.equal(changeOf('leads', 120, 100).tone, 'good');
  assert.equal(changeOf('leads', 80, 100).tone, 'bad');
});

test('polarity: an unknown metric defaults to neutral', () => {
  assert.equal(polarityOf('somethingNew'), 'neutral');
  assert.equal(changeOf('somethingNew', 200, 100).tone, 'flat');
});

test('small counts show the absolute change, not a percentage', () => {
  const r = changeOf('closed', 1, 2);
  assert.equal(r.mode, 'absolute');
  assert.equal(r.text, '−1');
  assert.equal(r.tone, 'flat');
  assert.equal(changeOf('closed', 5, 2).text, '+3');
});

test('a fractional count is rounded before showing an absolute change', () => {
  // Google Ads reports conversions as a fraction; "+9.5 leads" is not a real count.
  assert.equal(changeOf('leads', 9.5, 0).text, '+10');
  assert.equal(changeOf('leads', 2.4, 1.2).text, '+1');
});

test('counts at or above ten keep percentages', () => {
  const r = changeOf('leads', 20, 40);
  assert.equal(r.mode, 'percent');
  assert.equal(r.text, '▼ 50%');
});

test('currency and rate metrics keep percentages at small values', () => {
  assert.equal(changeOf('costPerClosure', 2, 4).mode, 'percent');
  assert.equal(changeOf('ctr', 2, 4).mode, 'percent');
});

test('no comparison, or nothing on either side, yields no badge', () => {
  assert.equal(changeOf('leads', 10, null), null);
  assert.equal(changeOf('leads', 0, 0), null);
});

test('rising from zero reads as new rather than an infinite percentage', () => {
  assert.equal(changeOf('leads', 40, 0).text, 'new');
});

test('kinds are classified for the small-count rule', () => {
  assert.equal(kindOf('leads'), 'count');
  assert.equal(kindOf('spend'), 'currency');
  assert.equal(kindOf('ctr'), 'rate');
});
