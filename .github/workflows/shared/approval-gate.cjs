'use strict';

const APPROVED = 'approved';
const NOT_APPROVED = 'not-approved';
const NO_ASSOCIATED_PR = 'no-associated-pr';
const INVALID_ASSOCIATION = 'invalid-association';
const RUN_MISMATCH = 'run-mismatch';
const INTERNAL_ERROR = 'internal-error';
const MAX_PR_NUMBER = 2147483647;
const MAX_NODE_ID_LENGTH = 512;
const MAX_BASE_LENGTH = 255;
const QUEUE_BRANCH = /^gh-readonly-queue\/(.+)\/pr-([1-9]\d*)-([0-9a-f]{7,40})$/;
const QUEUE_SUFFIX = /(?:^|\/)pr-[1-9]\d*-[0-9a-f]{7,40}(?:\/|$)/;

const REVIEW_DECISION_QUERY = `query PullRequestReviewDecision($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewDecision } }
}`;
const QUEUE_TARGET_QUERY = `query QueueTargetApproval($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewDecision } }
}`;

function sameRepository(left, right) {
  if (!left || !right) return false;
  if (Number.isInteger(left.id) && Number.isInteger(right.id)) return left.id === right.id;
  return typeof left.full_name === 'string' && left.full_name === right.full_name;
}

// The base capture is deliberately greedy because base branches may contain
// slashes. Reject another complete queue suffix in that base rather than
// interpreting a crafted multi-PR branch as a target.
function queueAssociation(branch) {
  const match = typeof branch === 'string' ? QUEUE_BRANCH.exec(branch) : null;
  if (!match || QUEUE_SUFFIX.test(match[1])) return null;
  const number = Number(match[2]);
  if (number > MAX_PR_NUMBER || match[1].length > MAX_BASE_LENGTH || /[\r\n]/.test(match[1])) return null;
  return { base: match[1], number, oid: match[3] };
}

function runMatches(run, context, expectedEvent, monitoredWorkflow, monitoredWorkflowPath) {
  const trigger = context.payload.workflow_run;
  return Number.isInteger(trigger?.id) && run.id === trigger.id &&
    sameRepository(run.repository, context.payload.repository) &&
    run.name === monitoredWorkflow && run.path === monitoredWorkflowPath &&
    Number.isInteger(trigger.run_attempt) && trigger.run_attempt > 0 &&
    Number.isInteger(run.run_attempt) && run.run_attempt === trigger.run_attempt &&
    run.event === expectedEvent && run.status === 'completed' && run.conclusion === 'failure';
}

async function resolvePullRequest(github, context, number) {
  if (!Number.isInteger(number) || number < 1) return null;
  const { data } = await github.rest.pulls.get({
    owner: context.repo.owner, repo: context.repo.repo, pull_number: number,
  });
  return data;
}

function regularMatches(pr, run) {
  return pr?.state === 'open' && pr.head?.sha === run.head_sha &&
    pr.head?.ref === run.head_branch && sameRepository(pr.head?.repo, run.head_repository);
}

function candidateNumbers(candidates) {
  if (candidates == null) return [];
  if (!Array.isArray(candidates)) return null;
  const numbers = new Set();
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate?.number) || candidate.number < 1) return null;
    numbers.add(candidate.number);
  }
  return numbers;
}

async function regularPullRequests(github, context, run) {
  if (!run.head_sha || !run.head_branch || !run.head_repository) return null;
  const eventNumbers = candidateNumbers(run.pull_requests);
  if (!eventNumbers) return null;
  const associated = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
    owner: context.repo.owner, repo: context.repo.repo, commit_sha: run.head_sha, per_page: 100,
  });
  const associatedNumbers = candidateNumbers(associated);
  if (!associatedNumbers) return null;
  const open = await github.paginate(github.rest.pulls.list, {
    owner: context.repo.owner, repo: context.repo.repo, state: 'open', per_page: 100,
  });
  if (!Array.isArray(open)) return null;
  const numbers = new Set([...eventNumbers, ...associatedNumbers]);
  for (const candidate of open) if (regularMatches(candidate, run)) numbers.add(candidate.number);
  const prs = await Promise.all([...numbers].map((number) => resolvePullRequest(github, context, number)));
  return prs.filter((pr) => regularMatches(pr, run));
}

async function reviewApproved(github, context, number, query = REVIEW_DECISION_QUERY) {
  const result = await github.graphql(query, { owner: context.repo.owner, repo: context.repo.repo, number });
  return result?.repository?.pullRequest?.reviewDecision === 'APPROVED';
}

module.exports = async function approvalGate({ core, context, expectedEvent, github, monitoredWorkflow, monitoredWorkflowPath }) {
  const reject = (reason) => { core.setOutput('approved', 'false'); core.setOutput('reason', reason); };
  const allow = (outputs = {}) => {
    for (const [key, value] of Object.entries(outputs)) core.setOutput(key, String(value));
    core.setOutput('approved', 'true'); core.setOutput('reason', APPROVED);
  };
  const fail = (message) => { reject(INTERNAL_ERROR); core.setFailed(message); };
  if (!['pull_request', 'merge_group'].includes(expectedEvent) || !monitoredWorkflow || !monitoredWorkflowPath || context.eventName !== 'workflow_run' || !Number.isInteger(context.payload.workflow_run?.id)) {
    reject(INVALID_ASSOCIATION);
    return;
  }
  let run;
  try {
    ({ data: run } = await github.rest.actions.getWorkflowRun({ owner: context.repo.owner, repo: context.repo.repo, run_id: context.payload.workflow_run.id }));
    if (!runMatches(run, context, expectedEvent, monitoredWorkflow, monitoredWorkflowPath)) { reject(RUN_MISMATCH); return; }
    if (expectedEvent === 'merge_group') {
      const target = queueAssociation(run.head_branch);
      if (!target) { reject(INVALID_ASSOCIATION); return; }
      const pr = await resolvePullRequest(github, context, target.number);
      if (!pr || pr.state !== 'open' || pr.draft === true || pr.base?.ref !== target.base ||
          typeof pr.node_id !== 'string' || !pr.node_id || pr.node_id.length > MAX_NODE_ID_LENGTH ||
          !/^[0-9a-f]{40}$/i.test(pr.head?.sha || '')) {
        reject(INVALID_ASSOCIATION);
        return;
      }
      if (!await reviewApproved(github, context, pr.number, QUEUE_TARGET_QUERY)) { reject(NOT_APPROVED); return; }
      allow({ target_pr: pr.number, target_pr_id: pr.node_id, target_head_oid: pr.head.sha, target_base: pr.base.ref });
      return;
    }
    const prs = await regularPullRequests(github, context, run);
    if (prs === null) { reject(INVALID_ASSOCIATION); return; }
    if (!prs.length) { reject(NO_ASSOCIATED_PR); return; }
    const approvals = await Promise.all(prs.map((pr) => reviewApproved(github, context, pr.number)));
    if (approvals.every(Boolean)) allow(); else reject(NOT_APPROVED);
  } catch (error) {
    fail(`Unable to evaluate approval gate: ${error.message}`);
  }
};

module.exports.queueAssociation = queueAssociation;
module.exports.regularPullRequests = regularPullRequests;
