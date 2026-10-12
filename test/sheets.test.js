import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stageFor, UNMAPPED, isoDate, detectDateOrder, campaignIdFromUrl, parseSheetUrl,
  fetchCampaignSheet, inferService,
} from '../src/campaignSheets.js';

test('statuses normalize onto fixed stages, case and separator insensitive', () => {
  assert.equal(stageFor('qualified'), 'Qualified');
  assert.equal(stageFor('no_response'), 'No response');
  assert.equal(stageFor('NO RESPONSE'), 'No response');
  assert.equal(stageFor('share the details'), 'In progress');
  assert.equal(stageFor('Followup'), 'In progress');
  assert.equal(stageFor('closed'), 'Closed');
  assert.equal(stageFor('junk'), 'Junk');
});

test('not qualified is tested before qualified, so it cannot land in Qualified', () => {
  assert.equal(stageFor('Not Qualified'), 'Not qualified');
  assert.equal(stageFor('not_qualified'), 'Not qualified');
});

test('a repeat, a cancellation and an untouched lead get stages of their own', () => {
  // None of these is folded into an existing stage: a repeat enquiry is not junk, a
  // cancellation is not a closure, and an untouched lead is not a judgement.
  assert.equal(stageFor('REPEATED'), 'Repeated');
  assert.equal(stageFor('CANCELLED'), 'Cancelled');
  assert.equal(stageFor('new_enquiry'), 'New enquiry');
  assert.equal(stageFor('CREATED'), 'New enquiry');
});

test('a status nobody has mapped still goes to Unmapped, never to a guessed stage', () => {
  assert.equal(stageFor('awaiting deposit'), UNMAPPED);
  assert.equal(stageFor(''), UNMAPPED);
});

test('a column of mixed date formats settles its own day/month order', () => {
  assert.equal(detectDateOrder(['8/28/2026', '10/12/2026']), 'mdy');
  assert.equal(detectDateOrder(['28/8/2026', '12/10/2026']), 'dmy');
  assert.equal(detectDateOrder(['10/12/2026']), null);
  assert.equal(isoDate('10/12/2026 12:36:38', 'mdy'), '2026-10-12');
  assert.equal(isoDate('10/12/2026', 'dmy'), '2026-12-10');
  assert.equal(isoDate('2026-07-30T08:51:36'), '2026-07-30');
  assert.equal(isoDate('Aug'), null);
});

test('a campaign id is recovered from the landing page URL', () => {
  assert.equal(campaignIdFromUrl('https://x/?gad_campaignid=24321808925&gclid=a'), '24321808925');
  assert.equal(campaignIdFromUrl('https://x/?gclid=a'), null);
});

test('a sheet link needs a spreadsheet id; the tab may be chosen later', () => {
  assert.equal(parseSheetUrl('https://docs.google.com/spreadsheets/d/ABC/edit#gid=7').gid, '7');
  assert.equal(parseSheetUrl('https://docs.google.com/spreadsheets/d/ABC/edit').gid, null);
  assert.ok(parseSheetUrl('nonsense').error);
});

// ---- date filtering, against a stubbed sheet -------------------------------
const grid = (dateHeader = 'created_time') => [
  [dateHeader, 'campaign_id', 'lead_status', 'Service'],
  ['2026-10-06T10:00:00', '111', 'closed', 'Pet Sitting'],
  ['2026-10-09T10:00:00', '111', 'qualified', 'Pet Sitting'],
  ['2026-09-01T10:00:00', '111', 'closed', 'Pet Sitting'],
  ['not a date', '111', 'closed', 'Pet Sitting'],
];

function stub(values) {
  const original = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).includes('docs.google.com')
    ? { ok: false, status: 403, text: async () => '' }
    : { ok: true, status: 200, text: async () => JSON.stringify({ values, tab: 'T' }) });
  return () => { globalThis.fetch = original; };
}

test('rows outside the range are excluded, and an undated row is dropped and counted', async () => {
  const restore = stub(grid());
  const t = await fetchCampaignSheet(
    { ssId: 'X', gid: '1', campaignId: '111' },
    'https://script.google.com/x/exec',
    { since: '2026-10-05', until: '2026-10-11' },
  );
  restore();
  assert.equal(t.total, 2, 'only the two October rows are in range');
  assert.equal(t.closed, 1, 'the September closure is excluded');
  assert.equal(t.qualified, 1);
  assert.equal(t.undated, 1, 'the unreadable date is counted, not silently kept');
  assert.equal(t.noDateColumn, false);
});

test('a tab with no date column warns instead of silently using every row', async () => {
  const restore = stub(grid('reference'));
  const t = await fetchCampaignSheet(
    { ssId: 'X', gid: '1', campaignId: '111' },
    'https://script.google.com/x/exec',
    { since: '2026-10-05', until: '2026-10-11' },
  );
  restore();
  assert.equal(t.noDateColumn, true, 'the missing date column is flagged');
  assert.equal(t.total, 4, 'every row is used, which is why it must be flagged');
});

test('unmapped statuses are reported with their raw spellings', async () => {
  const restore = stub([
    ['created_time', 'campaign_id', 'lead_status'],
    ['2026-10-06T10:00:00', '111', 'awaiting deposit'],
    ['2026-10-07T10:00:00', '111', 'site visit booked'],
    ['2026-10-08T10:00:00', '111', 'closed'],
  ]);
  const t = await fetchCampaignSheet(
    { ssId: 'X', gid: '1', campaignId: '111' },
    'https://script.google.com/x/exec',
    { since: '2026-10-05', until: '2026-10-11' },
  );
  restore();
  assert.equal(t.unmapped, 2);
  assert.equal(t.closed, 1);
  assert.deepEqual(t.unmappedValues, { 'awaiting deposit': 1, 'site visit booked': 1 });
});

test('repeats and cancellations are counted as their own stages, not as closures', async () => {
  const restore = stub([
    ['created_time', 'campaign_id', 'lead_status'],
    ['2026-10-06T10:00:00', '111', 'REPEATED'],
    ['2026-10-07T10:00:00', '111', 'CANCELLED'],
    ['2026-10-08T10:00:00', '111', 'closed'],
  ]);
  const t = await fetchCampaignSheet(
    { ssId: 'X', gid: '1', campaignId: '111' },
    'https://script.google.com/x/exec',
    { since: '2026-10-05', until: '2026-10-11' },
  );
  restore();
  assert.equal(t.closed, 1, 'a cancellation must not inflate closures');
  assert.equal(t.repeated, 1);
  assert.equal(t.cancelled, 1);
  assert.equal(t.unmapped, 0);
  assert.equal(t.total, 3);
});

test('a campaign with no rows yet reports zero rather than another campaign\'s leads', async () => {
  const restore = stub(grid());
  const t = await fetchCampaignSheet(
    { ssId: 'X', gid: '1', campaignId: '999' },
    'https://script.google.com/x/exec',
    { since: '2026-10-05', until: '2026-10-11' },
  );
  restore();
  assert.equal(t.total, 0);
  assert.equal(t.noRowsYet, true);
});

test('a campaign counts only the service its name is for', async () => {
  const restore = stub([
    ['created_time', 'campaign_id', 'lead_status', 'Service'],
    ['2026-10-07T10:00:00', '111', 'qualified', 'Pet Sitting'],
    ['2026-10-08T10:00:00', '111', 'qualified', 'Pet Sitting'],
    ['2026-10-09T10:00:00', '111', 'qualified', 'Pet Sitting'],
    ['2026-10-10T10:00:00', '111', 'qualified', 'Pet Boarding'],
  ]);
  const t = await fetchCampaignSheet(
    { ssId: 'X', gid: '1', campaignId: '111', campaignName: 'Search | Pet Sitting | Bangalore' },
    'https://script.google.com/x/exec',
    { since: '2026-10-05', until: '2026-10-11' },
  );
  restore();
  assert.equal(t.serviceNote, 'Pet Sitting');
  assert.equal(t.qualified, 3, 'the Pet Boarding enquiry belongs to a different service');
  assert.equal(t.total, 3);
});

test('a campaign whose name names no service still counts everything it brought', async () => {
  const restore = stub([
    ['created_time', 'campaign_id', 'lead_status', 'Service'],
    ['2026-10-07T10:00:00', '111', 'qualified', 'Pet Sitting'],
    ['2026-10-10T10:00:00', '111', 'qualified', 'Pet Boarding'],
  ]);
  const t = await fetchCampaignSheet(
    { ssId: 'X', gid: '1', campaignId: '111', campaignName: 'PU | Search | Core | BLR' },
    'https://script.google.com/x/exec',
    { since: '2026-10-05', until: '2026-10-11' },
  );
  restore();
  assert.equal(t.serviceNote, null, 'narrowing it to nothing would be worse than counting broadly');
  assert.equal(t.qualified, 2);
});
