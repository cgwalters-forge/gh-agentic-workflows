'use strict';

const fs = require('fs');
const approvalGate = require('./approval-gate.cjs');

const MAX_RUN_ATTEMPTS = 3;

module.exports = async function rerunWorkflow({
  core,
  context,
  expectedEvent,
  github,
  monitoredWorkflow,
  monitoredWorkflowPath,
  process,
}) {
  let agentOutput;
  try {
    if (!process.env.GH_AW_AGENT_OUTPUT) {
      throw new Error('GH_AW_AGENT_OUTPUT is not set');
    }
    agentOutput = JSON.parse(fs.readFileSync(process.env.GH_AW_AGENT_OUTPUT, 'utf8'));
  } catch (error) {
    core.setFailed(`Unable to parse safe output: ${error.message}`);
    return;
  }

  if (!Array.isArray(agentOutput.items)) {
    core.setFailed('Safe output must contain an items array');
    return;
  }

  const requests = agentOutput.items.filter((item) => item?.type === 'workflow_rerun');
  if (requests.length === 0) {
    core.info('No workflow rerun requested');
    return;
  }
  if (requests.length !== 1) {
    core.setFailed(`Refusing ${requests.length} workflow rerun requests; exactly one is allowed`);
    return;
  }

  const request = requests[0];
  if (!['failed', 'all'].includes(request.scope) || typeof request.reason !== 'string' || !request.reason.trim()) {
    core.setFailed('Workflow rerun request has an invalid scope or reason');
    return;
  }

  if (context.eventName !== 'workflow_run') {
    core.setFailed(`Refusing rerun from unsupported event ${context.eventName}`);
    return;
  }
  if (expectedEvent !== 'pull_request') {
    core.setFailed(`Refusing rerun for ${expectedEvent}: merge-group runs must be re-enqueued as a fresh queue entry`);
    return;
  }
  const { id: runId, run_attempt: triggerAttempt } = context.payload.workflow_run ?? {};
  if (!/^[1-9]\d*$/.test(String(runId))) {
    core.setFailed('Trigger did not provide a numeric workflow run ID');
    return;
  }

  let run;
  try {
    ({ data: run } = await github.rest.actions.getWorkflowRun({
      owner: context.repo.owner,
      repo: context.repo.repo,
      run_id: runId,
    }));
  } catch (error) {
    core.setFailed(`Unable to fetch workflow run ${runId}: ${error.message}`);
    return;
  }

  if (run.repository?.full_name !== context.payload.repository?.full_name ||
      run.event !== 'pull_request' ||
      run.name !== monitoredWorkflow ||
      run.path !== monitoredWorkflowPath ||
      run.status !== 'completed' ||
      run.conclusion !== 'failure') {
    core.setFailed('Refusing rerun: workflow run does not match the configured failed CI workflow');
    return;
  }
  if (run.run_attempt !== triggerAttempt) {
    core.setFailed(`Refusing stale workflow_run event for attempt ${triggerAttempt}; current attempt is ${run.run_attempt}`);
    return;
  }
  if (!Number.isInteger(run.run_attempt) || run.run_attempt >= MAX_RUN_ATTEMPTS) {
    core.setFailed(`Refusing rerun: attempt ${run.run_attempt} has reached the ${MAX_RUN_ATTEMPTS}-attempt cap`);
    return;
  }

  // Approval can change while the agent is inspecting logs. Re-check GitHub's
  // authoritative decision immediately before granting Actions write access.
  let prs;
  try {
    prs = await approvalGate.regularPullRequests(github, context, run);
  } catch (error) {
    core.setFailed(`Unable to re-check pull request approval: ${error.message}`);
    return;
  }
  if (!prs?.length) {
    core.setFailed('Refusing rerun: affected pull requests are not currently approved');
    return;
  }
  let approved;
  try {
    approved = await Promise.all(prs.map(async (pr) => {
      const result = await github.graphql(`query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) { pullRequest(number: $number) { state reviewDecision headRefOid } }
      }`, { owner: context.repo.owner, repo: context.repo.repo, number: pr.number });
      const current = result?.repository?.pullRequest;
      return current?.state === 'OPEN' && current.reviewDecision === 'APPROVED' && current.headRefOid === run.head_sha;
    }));
  } catch (error) {
    core.setFailed(`Unable to re-check pull request approval: ${error.message}`);
    return;
  }
  if (!approved.every(Boolean)) {
    core.setFailed('Refusing rerun: affected pull requests are not currently approved');
    return;
  }

  const endpoint = request.scope === 'failed'
    ? github.rest.actions.reRunWorkflowFailedJobs
    : github.rest.actions.reRunWorkflow;
  const preview = `Would rerun ${request.scope === 'failed' ? 'failed jobs' : 'all jobs'} for run ${run.id}, attempt ${run.run_attempt}`;
  core.info(`${preview}. Reason: ${request.reason.trim()}`);
  if (process.env.GH_AW_SAFE_OUTPUTS_STAGED === 'true') {
    await core.summary.addHeading('Workflow Rerun Preview', 2).addRaw(preview).write();
    return;
  }

  try {
    await endpoint({ owner: context.repo.owner, repo: context.repo.repo, run_id: run.id });
    core.info('Workflow rerun request submitted');
  } catch (error) {
    core.setFailed(`Unable to rerun workflow ${run.id}: ${error.message}`);
  }
};
