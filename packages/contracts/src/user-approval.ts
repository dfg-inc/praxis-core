import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DecisionKind } from "./authority.js";

/**
 * User approval: the whole authorization model.
 *
 *   Action -> Preview -> the user approves or rejects -> Execute -> Result.
 *
 * The person who uses Praxis decides, in the interface of their MCP client. Praxis asks through the client's own
 * elicitation dialog (the client shows the preview and returns Approve / Reject / Dismiss). That answer arrives as a
 * protocol response to the server, not as a tool argument, so an agent cannot write it.
 *
 * There is no other way to approve. A client that cannot show the dialog gets the preview and a clear message, and the
 * protected action is NOT executed: what the agent says the user said is never a decision. Read-only functionality and
 * the agent's own notes keep working.
 *
 * What an approval is bound to: one action and one subject (the exact content shown in the preview). An approval
 * for another action, or for the same action after its content changed, does not verify. Rejection and dismissal
 * stop the action; nothing runs.
 */

export const USER_APPROVAL_CONTRACT = "praxis.approval.user";
export const USER_APPROVAL_VERSION = 1;

/** How long an approval stays usable between being given and being applied. */
export const USER_APPROVAL_TTL_MS = 10 * 60 * 1000;

export type ApprovalChannelKind = "client-elicitation" | "terminal-prompt" | "host-permission" | "trusted-client" | "test";
/**
 * client-ui: given by the user in a dialog (the client's elicitation dialog, or the terminal's for the CLI); the agent
 * cannot write that answer.
 * host-prompt: OPT-IN only (PRAXIS_APPROVAL_MODE=host-permission). The call reached Praxis, so the host's own
 * tool-permission prompt was passed, and its arguments carried the exact plan. Praxis cannot verify that the prompt was
 * shown: an "always allow" setting removes it, and then the agent approves itself. Never the default.
 */
export type ApprovalAssurance = "client-ui" | "host-prompt" | "trusted-client";
/*
 * trusted-client: OPT-IN only (PRAXIS_APPROVAL_MODE=trusted-client, an extension setting). The user has told Praxis to
 * trust this client to run protected actions without asking about each one (for example Claude Desktop with "Always
 * allow"). It is NOT evidence that the user confirmed this action: the journal says "trusted-client". What stays: the
 * agent's confirmation=YES, the preview and its fingerprint (a stale plan is refused), argument checks and the journal.
 */

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
  readonly kind: "client-elicitation" | "terminal-prompt" | "host-permission" | "trusted-client";
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

export type ApprovalErrorCode = "APPROVAL_REQUIRED" | "APPROVAL_REJECTED" | "APPROVAL_CLIENT_UI_REQUIRED" | "APPROVAL_SCOPE_MISMATCH" | "APPROVAL_EXPIRED" | "APPROVAL_TIMED_OUT" | "APPROVAL_TOO_LARGE";

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

/**
 * Thrown by a channel whose answer is not available yet because the client has to be asked in a SEPARATE round trip
 * (the 2026-07-28 protocol revision: the server returns input_required and the client retries the call with the
 * answer). Nothing has been executed when this is thrown; the caller unwinds to the protocol layer, which asks and
 * re-runs the whole call. It is never an approval and never a refusal.
 */
export class ApprovalNeedsInput extends Error {
  readonly request: ApprovalRequest;
  constructor(request: ApprovalRequest) {
    super(`approval needed: ${request.summary}`);
    this.name = "ApprovalNeedsInput";
    this.request = request;
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
    assurance: input.channel === "host-permission" ? ("host-prompt" as const) : input.channel === "trusted-client" ? ("trusted-client" as const) : ("client-ui" as const),
    decidedAt: (input.now ?? new Date()).toISOString(),
    ...(input.reason ? { reason: input.reason } : {}),
  });
  issued.add(approval);
  return approval;
}

// --- the channel for the call being served -----------------------------------------------------------------------

type CallStore = { channel: UserApprovalChannel | undefined; approvals: UserApproval[] };
const channelStore = new AsyncLocalStorage<CallStore>();

/** The MCP integration wraps each tool call so deep code can ask the person without threading a parameter. */
export function withApprovalChannel<T>(channel: UserApprovalChannel | undefined, run: () => T): T {
  return channelStore.run({ channel, approvals: [] }, run);
}

export function currentApprovalChannel(): UserApprovalChannel | undefined {
  return channelStore.getStore()?.channel;
}

/** The approvals given while serving the current call, so the result can say how each was obtained. */
export function approvalsGivenInThisCall(): readonly UserApproval[] {
  return channelStore.getStore()?.approvals ?? [];
}

/** What a diagnostic can say about how approvals will be obtained right now. */
export function approvalModeReport(): { mode: "client-ui" | "no-dialog" | "trusted-client"; note: string } {
  const channel = currentApprovalChannel();
  if (channel?.kind === "trusted-client") {
    return { mode: "trusted-client", note: "TRUSTED CLIENT (enabled by you in the extension settings): protected actions run on the agent's confirmation=YES for a current preview, without a separate confirmation of each action. This is your standing permission for this client, not proof that you confirmed each action. Every action is still checked against its preview and journaled." };
  }
  if (channel && channel.kind !== "host-permission") {
    return { mode: "client-ui", note: "Protected actions are approved or rejected by the user in the client's own dialog; the agent cannot write that answer." };
  }
  return {
    mode: "no-dialog",
    note: "This client cannot show an approval dialog (no MCP elicitation support). Read-only tools and previews work; protected actions (Git, Jira, confirming a Story or decision, Quality fixes) are NOT executed, because nothing the agent says can stand in for the user's approval. Use a client that supports elicitation.",
  };
}

// --- decision log --------------------------------------------------------------------------------------------------

export type DecisionLogEntry = {
  at: string;
  action: string;
  summary: string;
  subjectDigest: string;
  decision: "approved" | "rejected" | "dismissed" | "refused";
  channel: ApprovalChannelKind | "none";
  reason?: string;
  /** The repository the decision was about (kept in the entry, not in the repository). */
  repository?: string;
};

/**
 * Where the decision journal lives: in the user's own Praxis home (PRAXIS_STATE_HOME, default ~/.praxis), one file per
 * repository, never inside the repository, so it can neither be committed nor edited as part of the project.
 */
export function decisionLogPath(repo: string): string {
  const root = resolve(repo);
  const home = process.env.PRAXIS_STATE_HOME?.trim() || join(homedir(), ".praxis");
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(home, "decisions", `${id}.jsonl`);
}

/** Best effort: the journal is for the user's later review; a write failure never changes a decision. */
export function logDecision(repo: string | undefined, entry: DecisionLogEntry): void {
  if (!repo) return;
  try {
    const path = decisionLogPath(repo);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify({ ...entry, repository: resolve(repo) })}\n`, { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

// --- asking ------------------------------------------------------------------------------------------------------

/**
 * Gets the user's decision for exactly this request, or throws before anything runs.
 *   rejected / dismissed -> APPROVAL_REJECTED
 *   no dialog available  -> APPROVAL_CLIENT_UI_REQUIRED, carrying the preview so it can be shown to the user
 * `confirmation` is the agent's own argument: "NO" records that the user declined (it can only stop things); "YES"
 * never approves anything, it only says the agent wants to apply what was previewed.
 */
export async function obtainUserApproval(request: ApprovalRequest, options: { confirmation?: string; repo?: string } = {}): Promise<UserApproval> {
  const base = { at: new Date().toISOString(), action: request.action, summary: request.summary, subjectDigest: subjectDigest(request.subject) };
  if (options.confirmation === "NO") {
    logDecision(options.repo, { ...base, decision: "rejected", channel: "none", reason: "the user declined (reported by the agent)" });
    throw new ApprovalError("APPROVAL_REJECTED", `${request.summary} was rejected. Nothing was changed.`, { rejected: true });
  }
  const channel = currentApprovalChannel();
  let answer: AskAnswer | undefined;
  if (channel) {
    try {
      answer = await channel.ask(request);
    } catch (error) {
      if (error instanceof ApprovalNeedsInput) throw error;
      // a channel that refuses with its own explanation (a plan that does not match) is passed through unchanged
      if (error instanceof ApprovalError) {
        logDecision(options.repo, { ...base, decision: "refused", channel: channel.kind, reason: error.message.slice(0, 200) });
        throw error;
      }
      logDecision(options.repo, { ...base, decision: "refused", channel: channel.kind, reason: error instanceof Error ? error.message : String(error) });
      throw new ApprovalError("APPROVAL_REQUIRED", `the client could not ask for approval: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`, previewDetails(request));
    }
  }
  if (channel && answer && answer.answer !== "unavailable") {
    if (answer.answer === "approve") {
      const approval = createUserApproval({ request, channel: channel.kind });
      channelStore.getStore()?.approvals.push(approval);
      logDecision(options.repo, { ...base, decision: "approved", channel: channel.kind, ...(answer.reason ? { reason: answer.reason } : {}) });
      return approval;
    }
    const dismissed = answer.answer === "dismiss";
    logDecision(options.repo, { ...base, decision: dismissed ? "dismissed" : "rejected", channel: channel.kind, ...(answer.reason ? { reason: answer.reason } : {}) });
    throw new ApprovalError("APPROVAL_REJECTED", `${request.summary} was ${dismissed ? "dismissed" : "rejected"} by the user. Nothing was changed.`, { rejected: !dismissed, dismissed });
  }
  logDecision(options.repo, { ...base, decision: "refused", channel: "none", reason: "no approval dialog in this client" });
  throw new ApprovalError(
    "APPROVAL_CLIENT_UI_REQUIRED",
    `${request.summary} was NOT executed. It needs the user's approval in the client's own dialog, and this client cannot show one (no MCP elicitation support). Show the user the preview below and tell them it can only be applied from a client that supports approval dialogs; the agent's or the user's text in chat is not accepted as approval. Read-only tools still work.`,
    previewDetails(request),
  );
}

function previewDetails(request: ApprovalRequest): Record<string, unknown> {
  return { executed: false, preview: { action: request.action, summary: request.summary, description: request.description, ...(request.risks?.length ? { risks: request.risks } : {}) } };
}

/**
 * Checks an approval before the contract acts on it: made by this module, for this action, for this exact subject,
 * recent. Throws before any change.
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
