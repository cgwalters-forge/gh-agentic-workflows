#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sharedWorkflowPath = path.join(__dirname, '..', '.github', 'workflows', 'shared', 'workflow-rerun.md');
const sharedWorkflow = fs.readFileSync(sharedWorkflowPath, 'utf8');
const rerunWorkflow = require('../.github/workflows/shared/workflow-rerun.cjs');
for (const workflow of ['ci-triage', 'queue-triage']) {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', `${workflow}.md`), 'utf8');
  assert.match(source, /^\s+workflow_run:/m, `${workflow} must trigger on workflow_run`);
  assert.doesNotMatch(source, /workflow_dispatch/, `${workflow} must not support workflow_dispatch`);
  assert.match(source, /toolsets: \[default, actions\]/, `${workflow} must grant GitHub Actions tool access`);
  assert.doesNotMatch(source, /^steps:/m, `${workflow} must not pre-fetch failure data`);
  assert.doesNotMatch(source, /\/tmp\/gh-aw\/agent\//, `${workflow} must not depend on pre-analysis files`);
  assert.match(source, /\$\{\{ github\.event\.workflow_run\.id \}\}/, `${workflow} must identify the triggering run`);
  for (const tool of ['actions_get', 'actions_list', 'get_job_logs']) {
    assert.match(source, new RegExp(`\\b${tool}\\b`), `${workflow} must instruct the agent to use ${tool}`);
  }
  if (workflow === 'queue-triage') {
    assert.match(source, /shared\/queue-reenqueue\.md/, 'queue must wire its custom safe output');
    assert.doesNotMatch(source, /workflow_rerun|shared\/workflow-rerun/, 'queue must never expose workflow reruns');
    assert.match(source, /fresh merge group/i, 'queue must explain fresh merge groups');
    assert.match(source, /target_pr_id/, 'queue gate output must flow to handler');
  } else {
    assert.match(source, /workflow_rerun/, 'PR triage must retain workflow rerun');
  }

  const lock = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', `${workflow}.lock.yml`),
    'utf8',
  );
  const triggers = lock.match(/^on:\n([\s\S]*?)\npermissions:/m);
  assert(triggers, `${workflow} compiled trigger block not found`);
  assert.match(triggers[1], /^\s+workflow_run:/m, `${workflow} compiled workflow must trigger on workflow_run`);
  assert.doesNotMatch(
    triggers[1],
    /workflow_dispatch/,
    `${workflow} compiled workflow must not trigger on workflow_dispatch`,
  );
  assert.match(source, /roles: \[admin, maintainer, maintain, write, triage, read\]/,
    `${workflow} must allow all GitHub roles through to its deterministic gate`);
  assert.match(lock, /GH_AW_REQUIRED_ROLES: "admin,maintainer,maintain,write,triage,read"/,
    `${workflow} lock must preserve all-role activation behavior`);
  for (const document of [source, lock]) {
    assert.match(document, /approval_gate:\n[\s\S]*?needs: pre_activation[\s\S]*?runs-on: ubuntu-slim/,
      `${workflow} approval gate must wait for activation on ubuntu-slim`);
    assert.match(document, /approval_gate:\n[\s\S]*?timeout-minutes: 5/,
      `${workflow} approval gate must have a five-minute bound`);
    assert.match(document, /permissions:\n\s+actions: read\n\s+contents: read\n\s+pull-requests: read/,
      `${workflow} approval gate must be read-only`);
    assert.match(document, /Checkout trusted approval gate[\s\S]*?ref: \$\{\{ github\.event\.repository\.default_branch \}\}[\s\S]*?persist-credentials: false/,
      `${workflow} approval gate must check out trusted default-branch code`);
    assert.match(document, /Checkout trusted approval gate[\s\S]*?sparse-checkout: \.github\/workflows\/shared/,
      `${workflow} approval gate must check out only its trusted helper`);
    assert.match(document, /actions\/github-script@(?:v9|[\da-f]+).*?github-token: \$\{\{ github\.token \}\}/s,
      `${workflow} approval gate must use github.token`);
  }
  assert.match(lock, /agent:\n\s+needs:\n\s+- activation\n\s+- approval_gate[\s\S]*?needs\.approval_gate\.outputs\.approved == 'true'/,
    `${workflow} compiled agent must wait for approval`);
  assert.match(lock, /monitoredWorkflow: 'CI',[\s\S]*monitoredWorkflowPath: '\.github\/workflows\/ci\.yml'/,
    `${workflow} approval gate must receive its monitored workflow identity`);
}
const queueHandler = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'shared', 'queue-reenqueue.cjs'), 'utf8');
assert.doesNotMatch(queueHandler, /reRunWorkflow|dequeuePullRequest/, 'queue handler must not rerun or dequeue Actions work');
assert.doesNotMatch(queueHandler, /TARGET_PR|TARGET_HEAD_OID/, 'queue handler must derive its target from the trusted run');
assert.match(queueHandler, /enqueuePullRequest[\s\S]*jump: false/, 'queue handler must enqueue without jumping');
const queueLock = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'queue-triage.lock.yml'), 'utf8');
assert.doesNotMatch(queueLock, /reRunWorkflow|permission-actions: write/, 'queue lock must not grant Actions rerun access');
assert.match(queueLock, /queue_reenqueue:[\s\S]*?runs-on: ubuntu-slim/, 'queue lock must wire the custom safe output');
assert.match(queueLock, /permission-merge-queues: write/, 'queue handler App token must request merge-queue write access');
assert.match(queueLock, /permission-actions: read/, 'queue handler App token must read the triggering run');
assert.match(sharedWorkflow, /permission-actions: write/, 'App token must allow workflow reruns');
assert.doesNotMatch(sharedWorkflow, /workflow_dispatch/, 'rerun handler must not support workflow_dispatch');
assert.match(
  sharedWorkflow,
  /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  'rerun handler must be checked out from the default branch',
);
assert.match(sharedWorkflow, /token: \$\{\{ github\.token \}\}/, 'checkout must use the job GITHUB_TOKEN');
assert.match(sharedWorkflow, /persist-credentials: false/, 'checkout must not persist credentials');
assert.match(sharedWorkflow, /github-token: \$\{\{ steps\.app-token\.outputs\.token \}\}/, 'rerun API must use the App token');
assert.match(sharedWorkflow, /permission-pull-requests: read/, 'rerun approval recheck must read pull requests');
assert.match(sharedWorkflow, /require\([\s\S]*workflow-rerun\.cjs/, 'safe-output wrapper must load trusted rerun handler');
assert.match(rerunWorkflow.toString(), /state reviewDecision headRefOid/, 'rerun must check current PR state and head OID');

const repository = { full_name: 'octo/example' };
const validRun = {
  id: 123,
  repository,
  event: 'pull_request',
  name: 'CI',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 1,
  head_sha: 'a'.repeat(40),
  head_branch: 'topic',
  head_repository: repository,
};
const request = { type: 'workflow_rerun', scope: 'failed', reason: 'DNS failure' };

async function execute({
  items = [request], rawOutput, run = validRun, eventName = 'workflow_run', workflowRun, triggerRunId = 123, triggerAttempt = 1,
  getRunError, endpointError, staged = false, associated = [{ number: 7 }], open = [], pull, graphPull,
}) {
  const outputPath = path.join(os.tmpdir(), `workflow-rerun-${process.pid}-${Math.random()}.json`);
  fs.writeFileSync(outputPath, rawOutput ?? JSON.stringify({ items }));
  const failed = [];
  const calls = [];
  const oldOutput = process.env.GH_AW_AGENT_OUTPUT;
  const oldStaged = process.env.GH_AW_SAFE_OUTPUTS_STAGED;
  process.env.GH_AW_AGENT_OUTPUT = outputPath;
  if (staged) process.env.GH_AW_SAFE_OUTPUTS_STAGED = 'true';
  else delete process.env.GH_AW_SAFE_OUTPUTS_STAGED;
  const core = {
    setFailed: (message) => failed.push(message),
    info: () => {},
    summary: { addHeading: () => core.summary, addRaw: () => core.summary, write: async () => {} },
  };
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => {
          if (getRunError) throw getRunError;
          return { data: run };
        },
        reRunWorkflowFailedJobs: async (value) => {
          if (endpointError) throw endpointError;
          calls.push({ endpoint: 'failed', request: value });
        },
        reRunWorkflow: async (value) => {
          if (endpointError) throw endpointError;
          calls.push({ endpoint: 'all', request: value });
        },
      },
      repos: { listPullRequestsAssociatedWithCommit: async () => ({ data: associated }) },
      pulls: {
        get: async () => ({ data: pull || { number: 7, state: 'open', head: { sha: validRun.head_sha, ref: 'topic', repo: repository } } }),
        list: async () => ({ data: open }),
      },
    },
    paginate: async (method, options) => (await method(options)).data,
    graphql: async () => ({ repository: { pullRequest: graphPull || { state: 'OPEN', reviewDecision: 'APPROVED', headRefOid: validRun.head_sha } } }),
  };
  const payload = { repository };
  if (eventName === 'workflow_run') {
    payload.workflow_run = workflowRun ?? { id: triggerRunId, run_attempt: triggerAttempt };
  }
  const context = {
    workflow: 'An Arbitrary Triage Name',
    eventName,
    repo: { owner: 'octo', repo: 'example' },
    payload,
  };

  try {
    await rerunWorkflow({
      core,
      context,
      expectedEvent: 'pull_request',
      github,
      monitoredWorkflow: 'CI',
      monitoredWorkflowPath: '.github/workflows/ci.yml',
      process,
    });
  } finally {
    fs.unlinkSync(outputPath);
    if (oldOutput === undefined) delete process.env.GH_AW_AGENT_OUTPUT;
    else process.env.GH_AW_AGENT_OUTPUT = oldOutput;
    if (oldStaged === undefined) delete process.env.GH_AW_SAFE_OUTPUTS_STAGED;
    else process.env.GH_AW_SAFE_OUTPUTS_STAGED = oldStaged;
  }
  return { failed, calls };
}

async function main() {
  const failures = [
    [{ rawOutput: '{not JSON' }, /Unable to parse safe output/],
    [{ items: null }, /items array/],
    [{ items: [request, request] }, /exactly one/],
    [{ items: [{ ...request, scope: 'other' }] }, /invalid scope or reason/],
    [{ items: [{ ...request, reason: ' ' }] }, /invalid scope or reason/],
    [{ run: { ...validRun, event: 'merge_group' } }, /configured failed CI workflow/],
    [{ run: { ...validRun, name: 'other' } }, /configured failed CI workflow/],
    [{ run: { ...validRun, path: '.github/workflows/other.yml' } }, /configured failed CI workflow/],
    [{ run: { ...validRun, repository: { full_name: 'octo/other' } } }, /configured failed CI workflow/],
    [{ run: { ...validRun, run_attempt: 2 } }, /stale workflow_run event/],
    [{ run: { ...validRun, run_attempt: 'bad' }, triggerAttempt: 'bad' }, /attempt cap/],
    [{ workflowRun: {} }, /numeric workflow run ID/],
    [{ triggerRunId: null }, /numeric workflow run ID/],
    [{ triggerRunId: 0 }, /numeric workflow run ID/],
    [{ triggerRunId: 'not-a-run-id' }, /numeric workflow run ID/],
    [{ eventName: 'workflow_dispatch' }, /unsupported event/],
    [{ eventName: 'push' }, /unsupported event/],
    [{ getRunError: new Error('not found') }, /Unable to fetch/],
    [{ endpointError: new Error('forbidden') }, /Unable to rerun/],
    [{ run: { ...validRun, run_attempt: 3 }, triggerAttempt: 3 }, /attempt cap/],
  ];
  for (const [options, expected] of failures) {
    const result = await execute(options);
    assert.match(result.failed[0], expected);
    assert.equal(result.calls.length, 0);
  }

  let result = await execute({ staged: true });
  assert.deepEqual(result, { failed: [], calls: [] });

  for (const scope of ['failed', 'all']) {
    result = await execute({ items: [{ ...request, scope }] });
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.calls, [{ endpoint: scope, request: { owner: 'octo', repo: 'example', run_id: 123 } }]);
  }
  result = await execute({ graphPull: { state: 'OPEN', reviewDecision: 'APPROVED', headRefOid: 'b'.repeat(40) } });
  assert.match(result.failed[0], /not currently approved/);
  assert.equal(result.calls.length, 0);
  const fork = { full_name: 'contributor/example' };
  const forkRun = { ...validRun, head_repository: fork };
  const forkPull = { number: 8, state: 'open', head: { sha: validRun.head_sha, ref: 'topic', repo: fork } };
  result = await execute({ run: forkRun, associated: [], open: [forkPull], pull: forkPull });
  assert.deepEqual(result.calls, [{ endpoint: 'failed', request: { owner: 'octo', repo: 'example', run_id: 123 } }]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
