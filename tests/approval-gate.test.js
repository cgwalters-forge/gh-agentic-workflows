#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const gate = require('../.github/workflows/shared/approval-gate.cjs');
const repository = { id: 1, full_name: 'octo/example' };
const fork = { id: 2, full_name: 'contributor/example' };
const regularRun = { id: 10, repository, name: 'CI', path: '.github/workflows/ci.yml', run_attempt: 1, event: 'pull_request', status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40), head_branch: 'topic', head_repository: fork, pull_requests: [] };
const regularPr = { number: 7, state: 'open', draft: false, node_id: 'PR_7', head: { sha: regularRun.head_sha, ref: 'topic', repo: fork }, base: { ref: 'main' } };
async function execute({ run = regularRun, pr = regularPr, decision = 'APPROVED', event = run.event, triggerAttempt = 1 } = {}) {
  const outputs = {}; const failed = [];
  const github = { rest: { actions: { getWorkflowRun: async () => ({ data: run }) }, repos: { listPullRequestsAssociatedWithCommit: async () => ({ data: [pr] }) }, pulls: { get: async () => ({ data: pr }), list: async () => ({ data: [pr] }) } }, paginate: async (method, options) => (await method(options)).data, graphql: async () => ({ repository: { pullRequest: { reviewDecision: decision } } }) };
  await gate({ core: { setOutput: (k, v) => { outputs[k] = v; }, setFailed: (v) => failed.push(v) }, context: { eventName: 'workflow_run', repo: { owner: 'octo', repo: 'example' }, payload: { repository, workflow_run: { id: 10, run_attempt: triggerAttempt } } }, expectedEvent: event, monitoredWorkflow: 'CI', monitoredWorkflowPath: '.github/workflows/ci.yml', github });
  return { outputs, failed };
}
async function main() {
  for (const [branch, expected] of [
    ['gh-readonly-queue/main/pr-7-abcdef0', { base: 'main', number: 7 }],
    ['gh-readonly-queue/release/v1/pr-7-abcdef0123456789', { base: 'release/v1', number: 7 }],
    ['gh-readonly-queue/main/pr-7-abcdef0/pr-8-abcdef1', null],
    ['gh-readonly-queue/main/pr-7-nothex!', null], ['gh-readonly-queue/main/pr-7-abcdef0/x', null],
  ]) { const value = gate.queueAssociation(branch); assert.deepEqual(value && { base: value.base, number: value.number }, expected); }
  assert.equal((await execute()).outputs.approved, 'true');
  for (const run of [{ ...regularRun, name: 'Other' }, { ...regularRun, path: '.github/workflows/other.yml' }, { ...regularRun, run_attempt: 2 }]) {
    assert.deepEqual((await execute({ run })).outputs, { approved: 'false', reason: 'run-mismatch' });
  }
  assert.equal((await execute({ run: { ...regularRun, run_attempt: 3 }, triggerAttempt: 3 })).outputs.approved, 'true');
  assert.deepEqual((await execute({ decision: 'CHANGES_REQUESTED' })).outputs, { approved: 'false', reason: 'not-approved' });
  const queueRun = { ...regularRun, event: 'merge_group', head_branch: 'gh-readonly-queue/release/v1/pr-7-abcdef0' };
  const queuePr = { ...regularPr, base: { ref: 'release/v1' } };
  const allowed = await execute({ run: queueRun, pr: queuePr });
  assert.deepEqual(allowed.outputs, { target_pr: '7', target_pr_id: 'PR_7', target_head_oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', target_base: 'release/v1', approved: 'true', reason: 'approved' });
  for (const pr of [{ ...queuePr, draft: true }, { ...queuePr, state: 'closed' }, { ...queuePr, base: { ref: 'main' } }, { ...queuePr, node_id: '' }]) assert.deepEqual((await execute({ run: queueRun, pr })).outputs, { approved: 'false', reason: 'invalid-association' });
  assert.deepEqual((await execute({ run: { ...queueRun, head_branch: 'gh-readonly-queue/main/pr-7-abcdef0/pr-8-abcdef1' } })).outputs, { approved: 'false', reason: 'invalid-association' });
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
