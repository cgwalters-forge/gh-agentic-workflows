#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const queueReenqueue = require('../.github/workflows/shared/queue-reenqueue.cjs');

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const REPOSITORY = { id: 1, full_name: 'octo/example' };
const MARKER = `<!-- gh-aw-queue-reenqueue head=${HEAD} -->`;
const OTHER_MARKER = `<!-- gh-aw-queue-reenqueue head=${OTHER_HEAD} -->`;

function output(items = [{ type: 'queue_reenqueue', reason: 'DNS failure' }]) {
  return { items };
}
function pull(overrides = {}) {
  return { number: 7, state: 'open', draft: false, node_id: 'PR_7', head: { sha: HEAD }, base: { ref: 'main' }, ...overrides };
}

async function execute(options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-reenqueue-'));
  const outputPath = path.join(temporary, 'agent-output.json');
  fs.writeFileSync(outputPath, JSON.stringify(options.output || output()));
  const oldEnvironment = process.env;
  process.env = {
    ...oldEnvironment,
    GH_AW_AGENT_OUTPUT: outputPath,
    GH_AW_APP_BOT_SLUG: options.bot === undefined ? 'bot[bot]' : options.bot,
  };
  if (options.staged) process.env.GH_AW_SAFE_OUTPUTS_STAGED = 'true';
  else delete process.env.GH_AW_SAFE_OUTPUTS_STAGED;

  const failures = [];
  const info = [];
  const events = [];
  const sleeps = [];
  const queueStates = [...(options.queueStates || [false])];
  let mutationArguments;
  const run = {
    id: options.runId === undefined ? 10 : options.runId,
    run_attempt: options.runAttempt === undefined ? 1 : options.runAttempt,
    repository: options.runRepository || REPOSITORY,
    name: options.name || 'CI',
    path: options.path || '.github/workflows/ci.yml',
    event: options.event || 'merge_group',
    status: options.status || 'completed',
    conclusion: options.conclusion || 'failure',
    head_branch: options.branch || 'gh-readonly-queue/main/pr-7-abcdef0',
  };
  const pr = {
    number: 7,
    state: options.prState || 'open',
    draft: options.draft || false,
    node_id: options.nodeId === undefined ? 'PR_7' : options.nodeId,
    head: { sha: options.head || HEAD },
    base: { ref: options.base || 'main' },
  };
  const prs = options.prs || [pr];
  let pullReads = 0;
  const github = {
    rest: {
      actions: { getWorkflowRun: async () => ({ data: run }) },
      pulls: { get: async () => ({ data: prs[Math.min(pullReads++, prs.length - 1)] }) },
      issues: {
        listComments: async () => ({ data: options.comments || [] }),
        createComment: async ({ body }) => {
          events.push({ type: 'receipt', body });
          if (options.receiptResponse === null) return undefined;
          return { data: { user: { login: options.receiptAuthor === undefined ? process.env.GH_AW_APP_BOT_SLUG : options.receiptAuthor } } };
        },
      },
    },
    paginate: async (method, arguments_) => (await method(arguments_)).data,
    graphql: async (query, variables) => {
      if (query.includes('QueueReenqueueTarget')) {
        const queued = queueStates.length > 1 ? queueStates.shift() : queueStates[0];
        return { repository: { pullRequest: { id: options.graphId || 'PR_7', reviewDecision: options.decision || 'APPROVED', mergeQueueEntry: queued ? { id: 'queue' } : null } } };
      }
      mutationArguments = variables;
      events.push({ type: 'mutation' });
      if (options.mutationError) throw new Error(options.mutationError);
      return {};
    },
  };
  const core = {
    setFailed: (message) => failures.push(message),
    info: (message) => info.push(message),
    summary: { addHeading() { return this; }, addRaw() { return this; }, write: async () => {} },
  };
  try {
    await queueReenqueue({
      core, context: {
        eventName: options.eventName || 'workflow_run', repo: { owner: 'octo', repo: 'example' },
        payload: { repository: REPOSITORY, workflow_run: { id: options.payloadId === undefined ? 10 : options.payloadId, run_attempt: options.payloadAttempt === undefined ? 1 : options.payloadAttempt } },
      }, github, monitoredWorkflow: 'CI', monitoredWorkflowPath: '.github/workflows/ci.yml', process,
      sleep: async (delay) => { sleeps.push(delay); },
    });
    return { events, failures, info, mutationArguments, sleeps };
  } finally {
    process.env = oldEnvironment;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const success = await execute();
  assert.deepEqual(success.failures, []);
  assert.deepEqual(success.events.map((event) => event.type), ['receipt', 'mutation']);
  assert.match(success.events[0].body, /Automatic re-enqueue requested/);
  assert.deepEqual(success.mutationArguments, { pullRequestId: 'PR_7', expectedHeadOid: HEAD, jump: false });
  assert.notEqual('abcdef0', HEAD, 'queue branch suffix is not compared to the PR head OID');

  for (const [name, options] of [
    ['no request', { output: output([]) }],
    ['multiple requests', { output: output([output().items[0], output().items[0]]) }],
    ['wrong payload id', { payloadId: 11 }],
    ['wrong returned id', { runId: 11 }],
    ['wrong run attempt', { runAttempt: 2 }],
    ['wrong repository', { runRepository: { id: 2, full_name: 'other/repo' } }],
    ['wrong workflow name', { name: 'Other CI' }],
    ['wrong workflow path', { path: '.github/workflows/other.yml' }],
    ['wrong event', { event: 'pull_request' }],
    ['closed PR', { prState: 'closed' }],
    ['draft PR', { draft: true }],
    ['changed base', { base: 'release' }],
    ['changed head after snapshot', { prs: [pull(), pull({ head: { sha: 'b'.repeat(40) } })] }],
    ['changed node ID after snapshot', { prs: [pull(), pull({ node_id: 'PR_8' })] }],
    ['invalid node ID', { nodeId: '' }],
    ['GraphQL node ID mismatch', { graphId: 'PR_8' }],
    ['unapproved PR', { decision: 'CHANGES_REQUESTED' }],
  ]) {
    const result = await execute(options);
    assert.ok(result.failures.length, name);
    assert.equal(result.events.length, 0, name);
  }

  const staged = await execute({ staged: true });
  assert.deepEqual(staged.events, []);

  const polling = await execute({ queueStates: [true, true, false] });
  assert.deepEqual(polling.sleeps, [1000, 1000]);
  assert.deepEqual(polling.events.map((event) => event.type), ['receipt', 'mutation']);

  const cap = await execute({ comments: [{ user: { login: 'bot[bot]' }, body: `${MARKER}\nreceipt` }, { user: { login: 'bot[bot]' }, body: `${MARKER}\nreceipt` }] });
  assert.match(cap.failures[0], /cap/);
  assert.deepEqual(cap.events, []);

  const forgedCap = await execute({ comments: [{ user: { login: 'bot[bot]' }, body: `${OTHER_MARKER}\nReason mentioned ${MARKER}` }, { user: { login: 'bot[bot]' }, body: MARKER }] });
  assert.deepEqual(forgedCap.failures, []);
  assert.deepEqual(forgedCap.events.map((event) => event.type), ['receipt', 'mutation']);

  const race = await execute({ mutationError: 'already queued', queueStates: [false, true] });
  assert.deepEqual(race.failures, []);
  assert.deepEqual(race.events.map((event) => event.type), ['receipt', 'mutation']);

  const failedMutation = await execute({ mutationError: 'forbidden' });
  assert.match(failedMutation.failures[0], /forbidden/);
  assert.deepEqual(failedMutation.events.map((event) => event.type), ['receipt', 'mutation']);

  for (const [name, options] of [
    ['wrong returned author', { receiptAuthor: 'other[bot]' }],
    ['missing returned author', { receiptResponse: null }],
    ['wrong configured bot', { bot: 'other[bot]', receiptAuthor: 'bot[bot]' }],
  ]) {
    const result = await execute(options);
    assert.match(result.failures[0], /configured App bot/, name);
    assert.deepEqual(result.events.map((event) => event.type), ['receipt'], name);
  }

  const sanitized = await execute({ output: output([{ type: 'queue_reenqueue', reason: `x\n${'y'.repeat(400)}` }]) });
  assert.ok(sanitized.events[0].body.length <= MARKER.length + 2 + 'Automatic re-enqueue requested after a transient merge-queue failure: '.length + 300);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
