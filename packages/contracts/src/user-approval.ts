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
 * A client that cannot show the dialog (or answers it without showing it, as the Claude Desktop Code tab does) can be served
 * by the Praxis approval page instead: a page the Runtime opens in the user's browser itself, whose secret link the agent
 * never receives. Without either, the protected action is NOT executed: what the agent says the user said is never a
 * decision. Read-only functionality and the agent's own notes keep working.
 *
 * What an approval is bound to: one action and one subject (the exact content shown in the preview). An approval
 * for another action, or for the same action after its content changed, does not verify. Rejection and dismissal
 * stop the action; nothing runs.
 *
 * Only an answer Praxis has evidence for is attributed to the user. A dialog answered faster than a person can read it, a
 * client that cannot ask, a timeout and the agent's own confirmation=NO are each recorded as what they are, never as the
 * user's rejection (see DecisionOutcome).
 */

export const USER_APPROVAL_CONTRACT = "praxis.approval.user";
export const USER_APPROVAL_VERSION = 1;

/** How long an approval stays usable between being given and being applied. */
export const USER_APPROVAL_TTL_MS = 10 * 60 * 1000;

export type ApprovalChannelKind = "client-elicitation" | "terminal-prompt" | "approval-page" | "host-permission" | "trusted-client" | "test";
/**
 * client-ui: given by the user in a dialog (the client's elicitation dialog, or the terminal's for the CLI); the agent
 * cannot write that answer.
 * approval-page: given by a click in the Praxis approval page, which the Runtime served on 127.0.0.1 and opened in the
 * user's browser itself. The agent never receives the page's secret link, so it cannot click through Praxis's own tools.
 * Weaker than a client dialog in one way that Praxis cannot detect: a browser-automation tool connected to that browser,
 * or a program running as the user, can operate the page (see docs/approval-threat-model.md).
 * host-prompt: OPT-IN only (PRAXIS_APPROVAL_MODE=host-permission). The call reached Praxis, so the host's own
 * tool-permission prompt was passed, and its arguments carried the exact plan. Praxis cannot verify that the prompt was
 * shown: an "always allow" setting removes it, and then the agent approves itself. Never the default.
 */
export type ApprovalAssurance = "client-ui" | "approval-page" | "host-prompt" | "trusted-client";
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

/** What Praxis observed about an answer: how long it took, which page request carried it. Never the content. */
export type AnswerEvidence = { latencyMs?: number; requestId?: string; via?: string; client?: string; /** When the person decided, if that was before the answer was used (the approval page). */ decidedAt?: string };

/**
 * approve / reject / dismiss: the user's answer in the client's dialog or the approval page.
 * unavailable: there was no way to ask the person on this connection, so nobody decided. `automatic` says the client
 * answered by itself (for example `decline` a few milliseconds after it was asked, with no dialog on screen): that is the
 * client's answer, never the user's. The request is then handled as a client with no dialog, never as a yes or a no.
 */
export type AskAnswer = {
  answer: "approve" | "reject" | "dismiss" | "unavailable";
  reason?: string;
  evidence?: AnswerEvidence;
  automatic?: "accept" | "decline" | "cancel";
  /** The channel wrote this decision to the journal when it was made (the approval page logs the click itself). */
  journaled?: true;
  /**
   * Which channel actually answered, when a channel hands some requests to another (Trusted Client and host-permission
   * hand acts only a person may perform to the approval page). The approval is labelled with this, never with the wrapper's.
   */
  channel?: ApprovalChannelKind;
};

/** A way to put an ApprovalRequest in front of the person. Supplied by the MCP client integration. */
export interface UserApprovalChannel {
  readonly kind: "client-elicitation" | "terminal-prompt" | "approval-page" | "host-permission" | "trusted-client";
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

const assuranceOf = (channel: ApprovalChannelKind): ApprovalAssurance =>
  channel === "host-permission" ? "host-prompt" : channel === "trusted-client" ? "trusted-client" : channel === "approval-page" ? "approval-page" : "client-ui";

/**
 * Codes for an action that did not run, one per outcome, so none is mistaken for another:
 *   APPROVAL_REJECTED            the user rejected it (in a dialog or the approval page)
 *   APPROVAL_DISMISSED           the user closed the dialog without deciding
 *   APPROVAL_WITHDRAWN           the agent stopped it (confirmation=NO): no decision of the user is claimed
 *   APPROVAL_PENDING             the approval page is open and nobody has decided yet
 *   APPROVAL_TIMED_OUT           a dialog was shown and nobody answered in time
 *   APPROVAL_EXPIRED             an answer or a page request is too old to use
 *   APPROVAL_CLIENT_UI_REQUIRED  there is no way to ask the user here (no dialog, or the client answered by itself)
 *   APPROVAL_SCOPE_MISMATCH / APPROVAL_TOO_LARGE / APPROVAL_REQUIRED  Praxis refused before asking
 */
export type ApprovalErrorCode =
  | "APPROVAL_REQUIRED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_DISMISSED"
  | "APPROVAL_WITHDRAWN"
  | "APPROVAL_PENDING"
  | "APPROVAL_CLIENT_UI_REQUIRED"
  | "APPROVAL_SCOPE_MISMATCH"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_TIMED_OUT"
  | "APPROVAL_TOO_LARGE";

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
    assurance: assuranceOf(input.channel),
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
export function approvalModeReport(): { mode: "client-ui" | "approval-page" | "no-dialog" | "trusted-client"; note: string } {
  const channel = currentApprovalChannel();
  if (channel?.kind === "trusted-client") {
    return { mode: "trusted-client", note: "TRUSTED CLIENT (enabled by you in the extension settings): protected actions run on the agent's confirmation=YES for a current preview, without a separate confirmation of each action. This is your standing permission for this client, not proof that you confirmed each action. Every action is still checked against its preview and journaled." };
  }
  if (channel?.kind === "approval-page") {
    return { mode: "approval-page", note: "This client cannot show Praxis's approval dialog, so Praxis opens its own approval page in your browser: you approve or reject the exact action there. The agent never gets that page's link. A browser-automation tool in that browser, or a program running as you, could still operate the page; Praxis cannot detect that." };
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

/**
 * What happened to one request, in the journal. Only approved / rejected / dismissed came from the user's own channel, and
 * then decidedBy names that channel (client-dialog, approval-page, terminal-prompt) and personVerified is false: Praxis
 * knows which channel answered, never that a person (rather than automation driving that channel) did. Entries written
 * before journal v2 have no decidedBy; see decision-journal.ts for how they are read and amended.
 *   pending        the approval page is open, nobody decided yet
 *   timed-out      a dialog was shown and nobody answered in time
 *   expired        a page request or an answer became too old to use
 *   withdrawn      the agent stopped the action (confirmation=NO)
 *   auto-answered  the client answered without showing anything to the user
 *   unavailable    there was no way to ask the user
 *   refused        Praxis refused before asking (a stale plan, too large, a mismatched scope)
 */
export type DecisionOutcome = "approved" | "rejected" | "dismissed" | "pending" | "timed-out" | "expired" | "withdrawn" | "auto-answered" | "unavailable" | "refused";
/**
 * What produced the outcome. The user's own channels: client-dialog (the client's approval dialog), approval-page (a click
 * in the Praxis approval page), terminal-prompt (the CLI). Otherwise: the client by itself, the agent, Praxis, a standing
 * permission (trusted-client, host-prompt), or nobody. None of these names a verified person.
 */
export type DecidedBy = "client-dialog" | "approval-page" | "terminal-prompt" | "client" | "agent" | "praxis" | "trusted-client" | "host-prompt" | "nobody";

/** The user's own channels: an answer from one of these is the user's decision as far as Praxis can know, never a proven person. */
export const USER_CHANNELS: ReadonlySet<DecidedBy> = new Set(["client-dialog", "approval-page", "terminal-prompt"]);

export type DecisionLogEntry = {
  at: string;
  action: string;
  summary: string;
  subjectDigest: string;
  decision: DecisionOutcome;
  channel: ApprovalChannelKind | "none";
  /** Journal format: 2 adds decidedBy and evidence. Absent on entries written before. */
  v?: 2;
  decidedBy?: DecidedBy;
  /** Always false when present: Praxis cannot verify that a person, rather than automation, answered a user channel. */
  personVerified?: false;
  evidence?: AnswerEvidence;
  reason?: string;
  /** The repository the decision was about (kept in the entry, not in the repository). */
  repository?: string;
};

const decidedByFor = (channel: ApprovalChannelKind): DecidedBy =>
  channel === "trusted-client" ? "trusted-client" : channel === "host-permission" ? "host-prompt" : channel === "approval-page" ? "approval-page" : channel === "terminal-prompt" ? "terminal-prompt" : "client-dialog";

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
    appendFileSync(path, `${JSON.stringify({ v: 2, ...entry, repository: resolve(repo) })}\n`, { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

// --- asking ------------------------------------------------------------------------------------------------------

/** Where the person answered, in words for a result message. */
const whereAsked = (kind: ApprovalChannelKind): string =>
  kind === "approval-page" ? "the Praxis approval page" : kind === "terminal-prompt" ? "the terminal prompt" : "the client's approval dialog";

/** The journal outcome for a refusal a channel raised itself, so a timeout or an open page is never logged as a "no". */
const OUTCOME_OF_CODE: Partial<Record<ApprovalErrorCode, { decision: DecisionOutcome; decidedBy: DecidedBy }>> = {
  APPROVAL_PENDING: { decision: "pending", decidedBy: "nobody" },
  APPROVAL_TIMED_OUT: { decision: "timed-out", decidedBy: "nobody" },
  APPROVAL_EXPIRED: { decision: "expired", decidedBy: "nobody" },
  APPROVAL_CLIENT_UI_REQUIRED: { decision: "unavailable", decidedBy: "nobody" },
};

/**
 * Gets the user's decision for exactly this request, or throws before anything runs. Every refusal carries
 * `details.outcome` and `details.decidedBy`, and the journal records the same, so a caller never has to guess:
 *   rejected in a user channel             -> APPROVAL_REJECTED   (decidedBy that channel, with its evidence)
 *   the dialog was closed without deciding -> APPROVAL_DISMISSED  (decidedBy that channel; not a rejection)
 *   confirmation=NO                        -> APPROVAL_WITHDRAWN  (decidedBy "agent"; never recorded as the user's)
 *   nobody could be asked / client answered by itself -> APPROVAL_CLIENT_UI_REQUIRED (decidedBy "nobody" / "client")
 *   the approval page is open              -> APPROVAL_PENDING    (raised by that channel; decidedBy "nobody")
 * `confirmation` is the agent's own argument: "NO" withdraws the request (it can only stop things); "YES" never approves
 * anything, it only says the agent wants to apply what was previewed.
 */
export async function obtainUserApproval(request: ApprovalRequest, options: { confirmation?: string; repo?: string } = {}): Promise<UserApproval> {
  const base = { at: new Date().toISOString(), action: request.action, summary: request.summary, subjectDigest: subjectDigest(request.subject) };
  if (options.confirmation === "NO") {
    logDecision(options.repo, { ...base, decision: "withdrawn", decidedBy: "agent", channel: "none", reason: "the agent withdrew the request (confirmation=NO); no decision of the user is claimed" });
    throw new ApprovalError(
      "APPROVAL_WITHDRAWN",
      `${request.summary} was withdrawn by the agent (confirmation=NO). Nothing was changed. This is not recorded as the user's decision: Praxis has no evidence of one.`,
      { executed: false, outcome: "withdrawn", decidedBy: "agent", rejected: false, dismissed: false },
    );
  }
  const channel = currentApprovalChannel();
  let answer: AskAnswer | undefined;
  if (channel) {
    try {
      answer = await channel.ask(request);
    } catch (error) {
      if (error instanceof ApprovalNeedsInput) throw error;
      // a channel that refuses with its own explanation (a plan that does not match, an open page) is passed through unchanged
      if (error instanceof ApprovalError) {
        const known = OUTCOME_OF_CODE[error.code] ?? { decision: "refused" as const, decidedBy: "praxis" as const };
        const raisedBy = (error.details.channel as ApprovalChannelKind | undefined) ?? channel.kind;
        if (error.details.journaled !== true) {
          const evidence = error.details.evidence as AnswerEvidence | undefined;
          logDecision(options.repo, { ...base, ...known, channel: raisedBy, ...(evidence ? { evidence } : {}), reason: error.message.slice(0, 200) });
        }
        error.details.outcome ??= known.decision;
        error.details.decidedBy ??= known.decidedBy;
        error.details.executed ??= false;
        delete error.details.journaled;
        throw error;
      }
      logDecision(options.repo, { ...base, decision: "refused", decidedBy: "praxis", channel: channel.kind, reason: error instanceof Error ? error.message : String(error) });
      throw new ApprovalError("APPROVAL_REQUIRED", `the client could not ask for approval: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`, { ...previewDetails(request), outcome: "refused", decidedBy: "praxis" });
    }
  }
  if (channel && answer && answer.answer !== "unavailable") {
    // labelled with the channel that answered, not the one that was asked (a wrapper may hand a request on)
    const answeredBy = answer.channel ?? channel.kind;
    const decidedBy = decidedByFor(answeredBy);
    const said = { channel: answeredBy, decidedBy, ...(USER_CHANNELS.has(decidedBy) ? { personVerified: false as const } : {}), ...(answer.evidence ? { evidence: answer.evidence } : {}), ...(answer.reason ? { reason: answer.reason } : {}) };
    if (answer.answer === "approve") {
      // an approval given earlier (a click in the page) ages from that click, not from when it is used
      const clicked = answer.evidence?.decidedAt ? new Date(answer.evidence.decidedAt) : undefined;
      const approval = createUserApproval({ request, channel: answeredBy, ...(clicked && Number.isFinite(clicked.getTime()) && clicked.getTime() <= Date.now() ? { now: clicked } : {}) });
      channelStore.getStore()?.approvals.push(approval);
      if (!answer.journaled) logDecision(options.repo, { ...base, decision: "approved", ...said });
      return approval;
    }
    const dismissed = answer.answer === "dismiss";
    if (!answer.journaled) logDecision(options.repo, { ...base, decision: dismissed ? "dismissed" : "rejected", ...said });
    const details = { executed: false, outcome: dismissed ? "dismissed" : "rejected", decidedBy, personVerified: false, channel: answeredBy, ...(answer.evidence ? { evidence: answer.evidence } : {}), ...(answer.reason ? { reason: answer.reason } : {}), rejected: !dismissed, dismissed };
    if (dismissed) {
      throw new ApprovalError("APPROVAL_DISMISSED", `${request.summary} was not run: ${whereAsked(answeredBy)} was closed without a decision. Nothing was changed. This is not a rejection; ask the user whether to try again.`, details);
    }
    throw new ApprovalError("APPROVAL_REJECTED", `${request.summary} was rejected in ${whereAsked(answeredBy)}, the user's own channel. Nothing was changed.`, details);
  }
  const automatic = answer?.automatic;
  const why = automatic
    ? `the client answered "${automatic}" ${answer?.evidence?.latencyMs ?? "?"} ms after it was asked, faster than a person can read the request${answer?.reason ? ` (${answer.reason})` : ""}; that is the client's answer, not the user's`
    : answer?.reason ?? "this client cannot show an approval dialog (no MCP elicitation support)";
  logDecision(options.repo, {
    ...base,
    decision: automatic ? "auto-answered" : "unavailable",
    decidedBy: automatic ? "client" : "nobody",
    channel: answer?.channel ?? channel?.kind ?? "none",
    ...(answer?.evidence ? { evidence: answer.evidence } : {}),
    reason: why.slice(0, 300),
  });
  throw new ApprovalError(
    "APPROVAL_CLIENT_UI_REQUIRED",
    `${request.summary} was NOT executed, and nobody rejected it: Praxis could not ask the user (${why}). Show the user the preview below. It can be applied where Praxis can ask: a client whose approval dialog works, or the Praxis approval page when the Runtime runs on the user's own computer. The agent's or the user's text in chat is not accepted as approval, and trying again here gives the same answer. Read-only tools still work.`,
    { ...previewDetails(request), outcome: automatic ? "auto-answered" : "unavailable", decidedBy: automatic ? "client" : "nobody", ...(answer?.evidence ? { evidence: answer.evidence } : {}), ...(automatic ? { automatic } : {}) },
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
