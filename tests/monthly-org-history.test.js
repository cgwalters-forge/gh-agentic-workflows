#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../scripts/monthly-org-history.js');

const cases = [
  ['leap month', '2024-02', '2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'],
  ['year boundary', '2024-12', '2024-12-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'],
];
for (const [name, month, start, end] of cases) assert.deepEqual(history.parseMonth(month), { month, start, end }, name);
assert.throws(() => history.parseMonth('2024-13'), /YYYY-MM/);
assert.throws(() => history.parseMonth('0099-01'), /at least 1000/);
for (const [name, timestamp, expected] of [
  ['start without milliseconds', '2024-02-01T00:00:00Z', true],
  ['start with milliseconds', '2024-02-01T00:00:00.000Z', true],
  ['end without milliseconds', '2024-03-01T00:00:00Z', false],
  ['end with milliseconds', '2024-03-01T00:00:00.000Z', false],
  ['malformed', 'not-a-date', false],
]) assert.equal(history.inInterval(timestamp, history.parseMonth('2024-02')), expected, name);
assert.equal(history.issueSince(history.parseMonth('2024-02')), '2024-01-31T23:59:59.999Z');

const interval = history.parseMonth('2024-02');
const items = history.classifyItems([
  { number: 2, title: 'PR', created_at: '2024-02-29T23:00:00Z', updated_at: '2024-03-01T00:00:00Z', merged_at: '2024-03-01T00:00:00.000Z', pull_request: {}, head: { ref: 'agent/task' }, labels: [{ name: 'agent/lgtm' }], body: 'Assisted-by: AI\nGenerated-by: AI' },
  { number: 1, title: 'issue', created_at: '2024-01-31T23:00:00Z', updated_at: '2024-02-01T00:00:00Z', labels: [{ name: 'agent/code' }], body: 'assisted-by: AI\nnot a marker' },
], 'repo', interval);
assert.deepEqual(items.map((item) => [item.number, item.createdInMonth, item.mergedInMonth, item.agentBranch]), [[1, false, false, false], [2, true, false, true]]);
assert.deepEqual(history.aggregateRepository(items, [{ name: 'Drafter', conclusion: 'success' }, { name: 'PR Review Agent', conclusion: 'failure' }]), { issuesCreated: 0, prsCreated: 1, prsMerged: 0, agentLabelSignals: { 'agent/code': 1, 'agent/lgtm': 1 }, agentBranchPrs: 1, attribution: { cohort: 'items_created_in_month', items: 1, assistedByAi: 1, generatedByAi: 1 }, workflows: { drafter: { success: 1 }, review: { failure: 1 } } });
for (const [run, expected] of [
  [{ name: 'Drafter' }, 'drafter'], [{ name: 'PR Review Agent' }, 'review'],
  [{ name: 'PR Fix Agent' }, 'fix'], [{ path: '.github/workflows/queue-triage.yml' }, 'queue-triage'],
  [{ name: 'fixture runner' }, null], [{ name: 'unrelated' }, null],
]) assert.equal(history.classifyWorkflow(run), expected);

const aggregate = fs.readFileSync(path.join(__dirname, 'fixtures/gh-aw-agent_usage.json'), 'utf8');
for (const [name, files, expected] of [
  ['real aggregate plus empty detection', [{ name: 'agent_usage.json', text: aggregate }, { name: 'agent/token_usage.jsonl', text: '{"ai_credits_total":999}' }, { name: 'detection/token_usage.jsonl', text: '' }], { known: true, aic: 66.989505, records: 1, source: 'aggregate+detection_empty', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: true, aic: 0, records: 0, source: 'detection_empty' } }],
  ['aggregate plus detection total', [{ name: 'agent_usage.json', text: aggregate }, { name: 'detection/token_usage.jsonl', text: '{"ai_credits_total":2}\n{"ai_credits_total":3}' }], { known: true, aic: 69.989505, records: 3, source: 'aggregate+detection_token_total', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: true, aic: 3, records: 2, source: 'detection_token_total' } }],
  ['duplicate archive files', [{ name: 'agent_usage.json', text: aggregate }, { name: 'agent_usage.json', text: aggregate }, { name: 'detection/token_usage.jsonl', text: '' }], { known: true, aic: 66.989505, records: 1, source: 'aggregate+detection_empty', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: true, aic: 0, records: 0, source: 'detection_empty' } }],
  ['token fallback uses cumulative maximum', [{ name: 'agent/token_usage.jsonl', text: '{"ai_credits_total":2}\n{"ai_credits_total":5}' }, { name: 'detection/token_usage.jsonl', text: '' }], { known: true, aic: 5, records: 2, source: 'agent_token_total+detection_empty', agent: { known: true, aic: 5, records: 2, source: 'agent_token_total' }, detection: { known: true, aic: 0, records: 0, source: 'detection_empty' } }],
  ['malformed aggregate is unknown', [{ name: 'agent_usage.json', text: '{"ai_credits":"bad"}' }, { name: 'agent/token_usage.jsonl', text: '{"ai_credits_total":5}' }, { name: 'detection/token_usage.jsonl', text: '' }], { known: false, aic: null, records: 0, source: 'malformed_aggregate' }],
  ['missing detection is unknown', [{ name: 'agent_usage.json', text: aggregate }], { known: false, aic: null, records: 0, source: 'aggregate+detection_missing', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: false, aic: null, records: 0, source: 'detection_missing' } }],
  ['malformed detection is unknown', [{ name: 'agent_usage.json', text: aggregate }, { name: 'detection/token_usage.jsonl', text: '{"ai_credits_this_response":3}' }], { known: false, aic: null, records: 0, source: 'aggregate+detection_malformed', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: false, aic: null, records: 0, source: 'detection_malformed' } }],
  ['arbitrary detection file is ignored', [{ name: 'agent_usage.json', text: aggregate }, { name: 'detection_usage.jsonl', text: '{"ai_credits_total":4}' }], { known: false, aic: null, records: 0, source: 'aggregate+detection_missing', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: false, aic: null, records: 0, source: 'detection_missing' } }],
  ['unrelated nested credits are absent', [{ name: 'other.json', text: '{"nested":{"ai_credits":9}}' }], { known: false, aic: null, records: 0, source: 'agent_missing+detection_missing', agent: { known: false, aic: null, records: 0, source: 'agent_missing' }, detection: { known: false, aic: null, records: 0, source: 'detection_missing' } }],
]) assert.deepEqual(history.extractAicFromFiles(files), expected, name);

for (const [name, coverage, runs, expected] of [
  ['no eligible runs stays unknown', { eligibleRuns: 0, runsWithValues: 0, total: null }, [], null],
  ['complete coverage totals values', { eligibleRuns: 1, runsWithValues: 1, total: null }, [{ aic: 4 }], 4],
  ['partial coverage stays unknown', { eligibleRuns: 2, runsWithValues: 1, total: null }, [{ aic: 4 }, { aic: null }], null],
]) { history.finalizeAicCoverage(coverage, runs); assert.equal(coverage.total, expected, name); }
assert.equal(history.aicEligible({ conclusion: 'skipped' }), false);
assert.equal(history.aicEligible({ conclusion: 'success' }), true);

const rangeStart = '2024-02-01T00:00:00.000Z';
const rangeEnd = '2024-02-02T00:00:00.000Z';
const calls = [];
const runs = history.boundedWorkflowRuns((start, end) => {
  calls.push([start, end]);
  return calls.length === 1 ? Array.from({ length: 1000 }, (_, id) => ({ id })) : [{ id: 2 }, { id: 1 }];
}, rangeStart, rangeEnd);
assert.deepEqual(runs.map((run) => run.id), [1, 2]);
assert.deepEqual(calls, [
  [rangeStart, '2024-02-01T23:59:59.999Z'],
  [rangeStart, '2024-02-01T11:59:59.999Z'],
  ['2024-02-01T12:00:00.000Z', '2024-02-01T23:59:59.999Z'],
]);
assert.throws(() => history.boundedWorkflowRuns(() => Array.from({ length: 1000 }, (_, id) => ({ id })), rangeStart, '2024-02-01T00:00:00.001Z'), /1,000-result cap/);

const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-history-test-'));
const output = path.join(outputDirectory, 'snapshot.json');
try {
  history.writeSnapshot(output, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { ok: true });
  assert.throws(() => history.writeSnapshot(output, { ok: false }), /EEXIST/);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
} finally { fs.rmSync(outputDirectory, { recursive: true, force: true }); }
