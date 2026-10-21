import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DecisionKind } from "./authority.js";

/**
 * User approval: the whole authorization model.
 *
 *   Action -> Preview -> the user approves or rejects -> Execute -> Result.
 *
 * The person who uses Praxis decides, in the interface of their MCP client. Praxis asks through the client's own
 * elicitation dialog (the client shows the preview and returns Approve / Reject / Dismiss). That answer arrives as a
 * protocol response to the server, not as a tool argument, so an agent cannot write it. This is the `client-ui`
 * assurance.
 *
 * A client that cannot ask (no elicitation support) leaves a fallback that is named for what it is: the agent calls
 * the apply tool with confirmation=YES after the person said yes in chat (and, usually, after the host's own tool
 * permission prompt). Praxis cannot tell whether a person was asked, so that approval is recorded as `unverified`.
 * Nothing in this file pretends otherwise; set PRAXIS_APPROVAL_STRICT=1 to refuse every approval that is not client-ui.
 *
 * What an approval is bound to: one action and one subject (the exact content shown in the preview). An approval
 * for another action, or for the same action after its content changed, does not verify. Rejection and dismissal
 * stop the action; nothing runs.
 */

export const USER_APPROVAL_CONTRACT = "praxis.approval.user";
export const USER_APPROVAL_VERSION = 1;

/** How long an approval stays usable between being given and being applied. */
export const USER_APPROVAL_TTL_MS = 10 * 60 * 1000;

export type ApprovalChannelKind = "client-elicitation" | "confirmation-flag" | "test";
export type ApprovalAssurance = "client-ui" | "unverified";

/** What the user is shown and what the decision binds. */
export type ApprovalRequest = {
  /** Stable action name: a tool name or a workflow act (confirm-story ...). */
  action: string;
  kind: DecisionKind;
  /** One line: what will happen. */
  summary: string;
  /** Everything needed to decide, in plain text (the preview). */
  description: string;
  /** The exact content the approval binds, as canonical text (a preview fingerprint, a story digest ...). */
  subject: string;
  risks?: string[];
};

/**
 * approve / reject / dismiss: the user's answer in the client's dialog.
 * unavailable: the client could not show the dialog for this connection (a protocol revision without it); the
 * request is then handled as a client with no dialog, never as a yes.
 */
export type AskAnswer = { answer: "approve" | "reject" | "dismiss" | "unavailable"; reason?: string };

/** A way to put an ApprovalRequest in front of the person. Supplied by the MCP client integration. */
export interface UserApprovalChannel {
  readonly kind: "client-elicitation";
  ask(request: ApprovalRequest): Promise<AskAnswer>;
}

export type UserApproval = Readonly<{
  contract: typeof USER_APPROVAL_CONTRACT;
  version: typeof USER_APPROVAL_VERSION;
  action: string;
  kind: DecisionKind;
  summary: string;
  subjectDigest: string;
  decision: "approved";
  channel: ApprovalChannelKind;
  assurance: ApprovalAssurance;
  decidedAt: string;
  reason?: string;
}>;

// A UserApproval is only real if this module made it. Parsed JSON, a tool argument or a look-alike object is not in
// this set, so no data an agent can send is ever mistaken for an approval.
const issued = new WeakSet<object>();

export const subjectDigest = (subject: string): string => `sha256:${createHash("sha256").update(subject, "utf8").digest("hex")}`;

function strict(): boolean {
  return process.env.PRAXIS_APPROVAL_STRICT?.trim() === "1";
}

export type ApprovalErrorCode = "APPROVAL_REQUIRED" | "APPROVAL_REJECTED" | "APPROVAL_CLIENT_UI_REQUIRED" | "APPROVAL_SCOPE_MISMATCH" | "APPROVAL_EXPIRED";

/** Standalone (no dependency on workflow.ts, which depends on this file). Carries the same `code` as WorkflowError. */
export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: ApprovalErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
    this.details = details;
  }
}

export function createUserApproval(input: {
  request: ApprovalRequest;
  channel: ApprovalChannelKind;
  reason?: string;
  now?: Date;
}): UserApproval {
  if (input.channel === "test" && process.env.PRAXIS_TEST_APPROVALS !== "1") {
    throw new ApprovalError("APPROVAL_REQUIRED", "a test approval is only accepted under the test harness");
  }
  const approval: UserApproval = Object.freeze({
    contract: USER_APPROVAL_CONTRACT,
    version: USER_APPROVAL_VERSION,
    action: input.request.action,
    kind: input.request.kind,
    summary: input.request.summary,
    subjectDigest: subjectDigest(input.request.subject),
    decision: "approved" as const,
    channel: input.channel,
    assurance: input.channel === "client-elicitation" || input.channel === "test" ? ("client-ui" as const) : ("unverified" as const),
    decidedAt: (input.now ?? new Date()).toISOString(),
    ...(input.reason ? { reason: input.reason } : {}),
  });
  issued.add(approval);
  return approval;
}

// --- the channel for the call being served -----------------------------------------------------------------------

const channelStore = new AsyncLocalStorage<UserApprovalChannel | undefined>();

/** The MCP integration wraps each tool call so deep code can ask the person without threading a parameter. */
export function withApprovalChannel<T>(channel: UserApprovalChannel | undefined, run: () => T): T {
  return channelStore.run(channel, run);
}

export function currentApprovalChannel(): UserApprovalChannel | undefined {
  return channelStore.getStore();
}

/** What a diagnostic can say about how approvals will be obtained right now. */
export function approvalModeReport(): { mode: "client-ui" | "unverified-fallback"; strict: boolean; note: string } {
  const channel = currentApprovalChannel();
  const isStrict = strict();
  if (channel) {
    return { mode: "client-ui", strict: isStrict, note: "Approvals are asked in the MCP client's own dialog; the answer cannot be written by the agent." };
  }
  return {
    mode: "unverified-fallback",
    strict: isStrict,
    note: isStrict
      ? "This client cannot ask for approval (no elicitation support) and PRAXIS_APPROVAL_STRICT=1 refuses unverified approvals, so protected actions will be refused."
      : "This client cannot ask for approval (no elicitation support). Protected actions run on the agent's confirmation=YES after you said yes in chat; Praxis cannot verify that a person was asked and records the approval as unverified.",
  };
}

// --- decision log ------------------------------------------------------------------------------------------------

export type DecisionLogEntry = {
  at: string;
  action: string;
  summary: string;
  subjectDigest: string;
  decision: "approved" | "rejected" | "dismissed" | "refused";
  channel: ApprovalChannelKind | "none";
  assurance: ApprovalAssurance | "none";
  reason?: string;
};

/** Best effort: the log is for the person's later review; a write failure never changes a decision. */
export function logDecision(repo: string | undefined, entry: DecisionLogEntry): void {
  if (!repo) return;
  try {
    const dir = join(resolve(repo), ".praxis", "approvals");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "decisions.jsonl"), `${JSON.stringify(entry)}\n`);
  } catch {
    /* ignore */
  }
}

// --- asking ------------------------------------------------------------------------------------------------------

/**
 * Gets the person's decision for exactly this request, or throws before anything runs.
 *   rejected / dismissed  -> APPROVAL_REJECTED
 *   no way to ask and no confirmation=YES -> APPROVAL_REQUIRED
 *   no way to ask, strict mode -> APPROVAL_CLIENT_UI_REQUIRED
 * `confirmation` is the agent's own argument: "YES" means "apply it"; "NO" records that the person declined.
 */
export async function obtainUserApproval(request: ApprovalRequest, options: { confirmation?: string; repo?: string } = {}): Promise<UserApproval> {
  const base = { at: new Date().toISOString(), action: request.action, summary: request.summary, subjectDigest: subjectDigest(request.subject) };
  if (options.confirmation === "NO") {
    logDecision(options.repo, { ...base, decision: "rejected", channel: "confirmation-flag", assurance: "unverified", reason: "the person declined (reported by the agent)" });
    throw new ApprovalError("APPROVAL_REJECTED", `${request.summary} was rejected. Nothing was changed.`, { rejected: true });
  }
  const channel = currentApprovalChannel();
  let answer: AskAnswer | undefined;
  if (channel) {
    try {
      answer = await channel.ask(request);
    } catch (error) {
      logDecision(options.repo, { ...base, decision: "refused", channel: "client-elicitation", assurance: "client-ui", reason: error instanceof Error ? error.message : String(error) });
      throw new ApprovalError("APPROVAL_REQUIRED", `the client could not ask for approval: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`);
    }
  }
  if (answer && answer.answer !== "unavailable") {
    if (answer.answer === "approve") {
      const approval = createUserApproval({ request, channel: "client-elicitation", reason: answer.reason });
      logDecision(options.repo, { ...base, decision: "approved", channel: "client-elicitation", assurance: "client-ui", ...(answer.reason ? { reason: answer.reason } : {}) });
      return approval;
    }
    const dismissed = answer.answer === "dismiss";
    logDecision(options.repo, { ...base, decision: dismissed ? "dismissed" : "rejected", channel: "client-elicitation", assurance: "client-ui", ...(answer.reason ? { reason: answer.reason } : {}) });
    throw new ApprovalError("APPROVAL_REJECTED", `${request.summary} was ${dismissed ? "dismissed" : "rejected"} by the user. Nothing was changed.`, { rejected: !dismissed, dismissed });
  }
  if (strict()) {
    logDecision(options.repo, { ...base, decision: "refused", channel: "none", assurance: "none", reason: "strict mode, no client approval dialog" });
    throw new ApprovalError("APPROVAL_CLIENT_UI_REQUIRED", `${request.summary} needs approval in the client's own dialog, and this client cannot ask (PRAXIS_APPROVAL_STRICT=1). Nothing was changed.`);
  }
  if (options.confirmation !== "YES") {
    throw new ApprovalError("APPROVAL_REQUIRED", `${request.summary} needs the user's approval. Show the preview, ask the user, then apply with confirmation=YES. Nothing was changed.`);
  }
  const approval = createUserApproval({ request, channel: "confirmation-flag" });
  logDecision(options.repo, { ...base, decision: "approved", channel: "confirmation-flag", assurance: "unverified", reason: "agent-relayed confirmation=YES; Praxis cannot verify that a person was asked" });
  return approval;
}

/**
 * Checks an approval before the contract acts on it: made by this module, for this action, for this exact subject,
 * recent, and (in strict mode) given in the client's dialog. Throws before any change.
 */
export function verifyUserApproval(approval: UserApproval | undefined, expected: { action: string; subject: string; now?: Date }): UserApproval {
  if (!approval || typeof approval !== "object" || !issued.has(approval)) {
    throw new ApprovalError("APPROVAL_REQUIRED", `${expected.action} needs the user's approval; none was given for this call`);
  }
  if (approval.decision !== "approved") throw new ApprovalError("APPROVAL_REJECTED", `${expected.action} was not approved`);
  if (approval.action !== expected.action) {
    throw new ApprovalError("APPROVAL_SCOPE_MISMATCH", `this approval is for ${approval.action}, not ${expected.action}`);
  }
  if (approval.subjectDigest !== subjectDigest(expected.subject)) {
    throw new ApprovalError("APPROVAL_SCOPE_MISMATCH", `this approval is not for ${expected.action} as it is now: the content differs from what the user approved`);
  }
  const age = (expected.now ?? new Date()).getTime() - Date.parse(approval.decidedAt);
  if (!Number.isFinite(age) || age > USER_APPROVAL_TTL_MS || age < -60_000) {
    throw new ApprovalError("APPROVAL_EXPIRED", "the user's approval is too old; ask again");
  }
  if (strict() && approval.assurance !== "client-ui") {
    throw new ApprovalError("APPROVAL_CLIENT_UI_REQUIRED", "strict mode accepts only approvals given in the client's own dialog");
  }
  return approval;
}

// --- the lease: writers refuse to run outside an approved action ----------------------------------------------------

const lease = new AsyncLocalStorage<{ action: string; approval?: UserApproval }>();

export function hasMutationLease(): boolean {
  return lease.getStore() !== undefined;
}

/** Lowest-level writers call this: a direct call outside an approved action throws before any write. */
export function requireMutationLease(): void {
  if (!lease.getStore()) {
    throw new ApprovalError("APPROVAL_REQUIRED", "direct mutation is not authorized: the user has not approved it. It must run through a Praxis apply tool, after the user's approval");
  }
}

/**
 * Agent-authored workflow records (a requirement, a handoff, a verdict) are the agent's own work product and nothing
 * is claimed about them beyond "the agent recorded this". Confirming a Story or decision, approving a service, and
 * anything with an effect outside the repository go through an approval instead.
 */
export function runWorkflowRecordWrite<T>(write: () => T): T {
  return lease.run({ action: "workflow-record" }, write);
}

/** Runs `write` inside the lease, for an approval this module issued. */
export function runApprovedMutation<T>(approval: UserApproval, write: () => T): T {
  if (!issued.has(approval) || approval.decision !== "approved") {
    throw new ApprovalError("APPROVAL_REQUIRED", "a mutation needs an approval issued for this call");
  }
  return lease.run({ action: approval.action, approval }, write);
}
