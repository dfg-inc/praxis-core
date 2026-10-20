import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { GitApprovalRequired } from "./git-authorization.js";
import { APPROVAL_SERVICE_PROTOCOL, ApprovalServiceError, assessApprovalService, callApprovalService, type ServiceReply } from "./approval-service.js";
import { testIdentityOverrideActive } from "./deployment.js";

/**
 * Hands the protected step of a Git delivery operation to the Approval Service. The delivery code (plugins/vcs)
 * prepares and verifies as before, then, instead of running `git commit` / `git push` / creating a pull request with
 * the agent's own identity and credentials, asks the delegate to. The delegate submits the request, and executes it
 * only after the service reports a human approval; otherwise it throws before anything was changed.
 */

export type DelegatedCommit = { repo: string; workItemId: string; branch: string; message: string; paths: string[] };
export type DelegatedPush = { repo: string; workItemId: string; remoteName: string; branch: string };
export type DelegatedMergeRequest = { repo: string; workItemId: string; remoteName: string; sourceBranch: string; targetBranch: string; title: string; body: string };

export type GitExecutorDelegate = {
  commit(input: DelegatedCommit): Promise<{ commitSha: string; treeSha: string }>;
  push(input: DelegatedPush): Promise<{ pushedSha: string }>;
  mergeRequest(input: DelegatedMergeRequest): Promise<{ id: string; url: string }>;
};

const store = new AsyncLocalStorage<GitExecutorDelegate>();
export const gitExecutorDelegate = (): GitExecutorDelegate | undefined => store.getStore();
export const withGitExecutorDelegate = <T>(delegate: GitExecutorDelegate, fn: () => T): T => store.run(delegate, fn);

function refuse(reply: Extract<ServiceReply, { ok: false }>, what: string): never {
  const code = reply.code === "APPROVAL_REJECTED" || reply.code === "APPROVAL_REQUIRED" || reply.code === "APPROVAL_ISOLATION_UNAVAILABLE" ? reply.code : "APPROVAL_REQUIRED";
  throw new GitApprovalRequired(code as "APPROVAL_REQUIRED" | "APPROVAL_REJECTED" | "APPROVAL_ISOLATION_UNAVAILABLE", `${what} was refused by the approval service (${reply.code}): ${reply.message}`, { service: reply.code, ...(reply.details ?? {}) });
}

/**
 * Fails closed before anything is submitted: a service that does not speak this protocol, or whose isolation this side
 * cannot establish, is not an approval authority. Only the unpackaged test harness (PRAXIS_TEST_ALLOW_SAME_IDENTITY=1
 * in a non-production build) may use a same-identity service, and the doctor still reports it as unisolated.
 */
async function assertUsableService(what: string, endpoint: string | undefined): Promise<void> {
  const assessment = await assessApprovalService({ endpoint, timeoutMs: 5000 });
  if (!assessment.reachable) {
    throw new GitApprovalRequired("APPROVAL_ISOLATION_UNAVAILABLE", `${what} needs the approval service and it is not available: ${assessment.reasons.join("; ")}. Nothing was changed.`, { service: "SERVICE_UNAVAILABLE" });
  }
  if (assessment.health && assessment.health.protocol !== APPROVAL_SERVICE_PROTOCOL) {
    throw new GitApprovalRequired("APPROVAL_ISOLATION_UNAVAILABLE", `the approval service speaks ${assessment.health.protocol}, this Runtime speaks ${APPROVAL_SERVICE_PROTOCOL}; refusing. Nothing was changed.`, { service: "PROTOCOL_MISMATCH" });
  }
  if (!assessment.isolated && !testIdentityOverrideActive()) {
    throw new GitApprovalRequired("APPROVAL_ISOLATION_UNAVAILABLE", `${what} is refused: the approval service is not verified as isolated from the agent (${assessment.reasons.join("; ")}). Nothing was changed.`, { service: "NOT_ISOLATED", reasons: assessment.reasons });
  }
}

/** Submit, then execute once approved. A repeated call after the owner decides completes the same request (the service derives the same request id). */
async function run(what: string, submit: Record<string, unknown>, endpoint: string | undefined): Promise<Record<string, unknown>> {
  await assertUsableService(what, endpoint);
  let submitted: ServiceReply;
  try {
    submitted = await callApprovalService(submit, { endpoint });
  } catch (error) {
    if (error instanceof ApprovalServiceError) throw new GitApprovalRequired("APPROVAL_ISOLATION_UNAVAILABLE", `${what} needs the approval service and it is not available: ${error.message}. Nothing was changed.`, { service: error.code });
    throw error;
  }
  if (!submitted.ok) refuse(submitted, what);
  const state = submitted.state as string;
  if (state === "awaiting-operator") {
    throw new GitApprovalRequired("APPROVAL_REQUIRED", `${what} is waiting for the owner. The approval service shows the exact request at ${submitted.operatorUrl}; the owner approves it with Touch ID, Windows Hello or a security key. Then apply this same request again. Nothing was changed.`, { requestId: submitted.requestId, status: "awaiting-operator", operatorUrl: submitted.operatorUrl, fingerprint: submitted.fingerprint, executedBy: "approval-service" });
  }
  if (state === "rejected") throw new GitApprovalRequired("APPROVAL_REJECTED", `the owner rejected ${what} (request ${submitted.requestId}). Nothing was changed; a changed request is a new request.`, { requestId: submitted.requestId, status: "rejected" });
  if (state === "expired") throw new GitApprovalRequired("APPROVAL_REQUIRED", `the approval for ${what} expired (request ${submitted.requestId}). Apply again to propose a fresh request. Nothing was changed.`, { requestId: submitted.requestId, status: "expired" });
  if (state === "completed") return (submitted.result ?? {}) as Record<string, unknown>;
  if (state === "failed" || state === "executing") {
    throw new GitApprovalRequired("APPROVAL_REQUIRED", `${what} is ${state === "executing" ? "being executed" : "consumed and failed"} in the approval service (${String(submitted.detail ?? "")}). Check the repository before asking again.`, { requestId: submitted.requestId, status: state });
  }
  const executed = await callApprovalService({ op: "execute", requestId: submitted.requestId }, { endpoint });
  if (!executed.ok) refuse(executed, what);
  return (executed.result ?? {}) as Record<string, unknown>;
}

export function approvalServiceDelegate(endpoint?: string): GitExecutorDelegate {
  return {
    async commit(i) {
      const result = await run("git commit", { op: "submit", operation: "git_commit", repository: resolve(i.repo), workItemId: i.workItemId, params: { message: i.message, branch: i.branch, paths: i.paths } }, endpoint);
      return { commitSha: String(result.commit), treeSha: String(result.tree) };
    },
    async push(i) {
      const result = await run("git push", { op: "submit", operation: "git_push", repository: resolve(i.repo), workItemId: i.workItemId, params: { remote: i.remoteName, branch: i.branch } }, endpoint);
      return { pushedSha: String(result.pushed) };
    },
    async mergeRequest(i) {
      const result = await run("opening the merge request", { op: "submit", operation: "merge_request", repository: resolve(i.repo), workItemId: i.workItemId, params: { remote: i.remoteName, sourceBranch: i.sourceBranch, targetBranch: i.targetBranch, title: i.title, body: i.body } }, endpoint);
      return { id: String(result.id), url: String(result.url) };
    },
  };
}
