'use strict';

const fs = require('fs');
const approvalGate = require('./approval-gate.cjs');
const MAX_AUTOMATIC_REENQUEUES = 2;
const POLL_ATTEMPTS = 3;
const POLL_DELAY_MS = 1000;
const MAX_REASON_LENGTH = 300;
const RECEIPT_PREFIX = '<!-- gh-aw-queue-reenqueue head=';
const RECEIPT_SUFFIX = ' -->';
const TARGET_QUERY = `query QueueReenqueueTarget($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id reviewDecision mergeQueueEntry { id } } }
}`;
const ENQUEUE_MUTATION = `mutation QueueReenqueue($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  enqueuePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, jump: false}) { clientMutationId }
}`;

function marker(head) { return `${RECEIPT_PREFIX}${head}${RECEIPT_SUFFIX}`; }
function sanitizeReason(reason) { return reason.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_REASON_LENGTH); }
function parseRequest(process) {
  if (!process.env.GH_AW_AGENT_OUTPUT) throw new Error('GH_AW_AGENT_OUTPUT is not set');
  const output = JSON.parse(fs.readFileSync(process.env.GH_AW_AGENT_OUTPUT, 'utf8'));
  if (!Array.isArray(output.items)) throw new Error('Safe output must contain an items array');
  const items = output.items.filter((item) => item?.type === 'queue_reenqueue');
  if (items.length !== 1 || typeof items[0].reason !== 'string' || !sanitizeReason(items[0].reason)) throw new Error('Safe output must contain exactly one queue_reenqueue with a reason');
  return sanitizeReason(items[0].reason);
}
function sameRepository(left, right) {
  if (!left || !right) return false;
  if (Number.isInteger(left.id) && Number.isInteger(right.id)) return left.id === right.id;
  return left.full_name === right.full_name;
}
function exactRun(run, context, monitoredWorkflow, monitoredWorkflowPath) {
  const trigger = context.payload.workflow_run;
  return Number.isInteger(trigger?.id) && run?.id === trigger.id && sameRepository(run.repository, context.payload.repository) &&
    Number.isInteger(trigger.run_attempt) && trigger.run_attempt > 0 && run.run_attempt === trigger.run_attempt &&
    run.name === monitoredWorkflow && run.path === monitoredWorkflowPath && run.event === 'merge_group' && run.status === 'completed' && run.conclusion === 'failure';
}
async function deriveTarget(github, context, run) {
  const association = approvalGate.queueAssociation(run.head_branch);
  if (!association) return null;
  // The queue branch suffix identifies the synthetic merge-group base SHA,
  // not the PR head OID; only the API-fetched PR head is safe for enqueue.
  const { data: pr } = await github.rest.pulls.get({ owner: context.repo.owner, repo: context.repo.repo, pull_number: association.number });
  if (!pr || pr.state !== 'open' || pr.draft === true || pr.base?.ref !== association.base || typeof pr.node_id !== 'string' || !pr.node_id || !/^[0-9a-f]{40}$/i.test(pr.head?.sha || '')) return null;
  return { number: association.number, id: pr.node_id, head: pr.head.sha, base: association.base };
}
async function targetState(github, context, target) {
  const { data: pr } = await github.rest.pulls.get({ owner: context.repo.owner, repo: context.repo.repo, pull_number: target.number });
  if (!pr || pr.state !== 'open' || pr.draft === true || pr.base?.ref !== target.base || pr.head?.sha !== target.head || pr.node_id !== target.id) return null;
  const graph = await github.graphql(TARGET_QUERY, { owner: context.repo.owner, repo: context.repo.repo, number: target.number });
  const graphPr = graph?.repository?.pullRequest;
  if (!graphPr || graphPr.id !== target.id || graphPr.reviewDecision !== 'APPROVED') return null;
  return { queued: graphPr.mergeQueueEntry != null };
}
async function receiptCount(github, context, target, bot) {
  if (!bot) throw new Error('GH_AW_APP_BOT_SLUG is required to count queue re-enqueue receipts');
  const comments = await github.paginate(github.rest.issues.listComments, { owner: context.repo.owner, repo: context.repo.repo, issue_number: target.number, per_page: 100 });
  return comments.filter((comment) => comment?.user?.login === bot && typeof comment.body === 'string' && comment.body.startsWith(`${marker(target.head)}\n`)).length;
}
async function reserveAttempt(github, context, target, reason, bot) {
  const response = await github.rest.issues.createComment({ owner: context.repo.owner, repo: context.repo.repo, issue_number: target.number, body: `${marker(target.head)}\nAutomatic re-enqueue requested after a transient merge-queue failure: ${reason}` });
  if (response?.data?.user?.login !== bot) throw new Error('Receipt comment was not authored by the configured App bot');
}

module.exports = async function queueReenqueue({ core, context, github, monitoredWorkflow, monitoredWorkflowPath, process, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let reason;
  try { reason = parseRequest(process); } catch (error) { core.setFailed(error.message); return; }
  if (context.eventName !== 'workflow_run') { core.setFailed('Refusing queue re-enqueue outside workflow_run'); return; }
  try {
    const { data: run } = await github.rest.actions.getWorkflowRun({ owner: context.repo.owner, repo: context.repo.repo, run_id: context.payload.workflow_run?.id });
    if (!exactRun(run, context, monitoredWorkflow, monitoredWorkflowPath)) { core.setFailed('Refusing queue re-enqueue: workflow run does not exactly match the configured failed merge-queue CI workflow'); return; }
    const target = await deriveTarget(github, context, run);
    if (!target) { core.setFailed('Refusing queue re-enqueue: branch-named target pull request is not current and eligible'); return; }
    let state = await targetState(github, context, target);
    for (let attempt = 0; state?.queued && attempt < POLL_ATTEMPTS; attempt += 1) { await sleep(POLL_DELAY_MS); state = await targetState(github, context, target); }
    if (!state) { core.setFailed('Refusing queue re-enqueue: target pull request changed, closed, draft, or lost approval'); return; }
    if (state.queued) { core.info('Target is already in the merge queue; treating the race as idempotent'); return; }
    if (await receiptCount(github, context, target, process.env.GH_AW_APP_BOT_SLUG) >= MAX_AUTOMATIC_REENQUEUES) { core.setFailed(`Refusing queue re-enqueue: unchanged head reached the ${MAX_AUTOMATIC_REENQUEUES}-automatic-reenqueue cap`); return; }
    if (process.env.GH_AW_SAFE_OUTPUTS_STAGED === 'true') { await core.summary.addHeading('Queue Re-enqueue Preview', 2).addRaw(`Would re-enqueue PR #${target.number}`).write(); return; }
    // Reserve before mutating: a later crash or mutation failure must consume
    // an attempt rather than allowing an unchanged head to loop forever.
    await reserveAttempt(github, context, target, reason, process.env.GH_AW_APP_BOT_SLUG);
    try { await github.graphql(ENQUEUE_MUTATION, { pullRequestId: target.id, expectedHeadOid: target.head, jump: false }); }
    catch (error) { if (!(await targetState(github, context, target))?.queued) throw error; core.info('Target was concurrently re-enqueued; treating the race as idempotent'); return; }
    core.info(`Re-enqueued PR #${target.number}`);
  } catch (error) { core.setFailed(`Unable to re-enqueue merge queue target: ${error.message}`); }
};
module.exports.constants = { ENQUEUE_MUTATION, MAX_AUTOMATIC_REENQUEUES, MAX_REASON_LENGTH, POLL_ATTEMPTS, POLL_DELAY_MS };
