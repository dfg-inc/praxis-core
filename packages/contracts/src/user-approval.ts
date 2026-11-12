import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { DecisionKind } from "./authority.js";

/**
 * User approval: the whole authorization model.
 *
 *   Action -> Preview -> the client's approval dialog answers approve or reject -> Execute -> Result.
 *
 * Praxis asks through the MCP client's own elicitation dialog (the client shows the preview and returns Approve / Reject /
 * Dismiss). That answer arrives as a protocol response to the server, not as a tool argument, so an agent cannot write it
 * through Praxis's tools.
 *
 * An answer in that dialog is a client response: Praxis knows the client's dialog answered, not who or what answered it. It
 * is not verified approval by a person, and nothing on the user's computer can provide that: a program running as the user
 * (T-same-user) can start its own MCP client that declares the dialog and answers it (R1), or change the installed Runtime.
 * No local check stops that, and Praxis does not claim otherwise. Every approval, result and journal entry therefore says
 * which channel answered (`channel`, `decidedBy`) and that neither a person nor an independent authority verified it
 * (`personVerified: false`, `independentlyVerified: false`). No other channel stands in for the dialog: not the agent's
 * confirmation, not a page Praxis serves, not a setting in a repository, the environment or the account's files. A client
 * that cannot show the dialog (or answers it without showing it, as the Claude Desktop Code tab does) gets the protected
 * action NOT executed. Read-only functionality and the agent's own notes keep working.
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

/** approval-page, host-permission and trusted-client are no longer produced by a shipped Runtime; kept so earlier journals read. */
export type ApprovalChannelKind = "client-elicitation" | "terminal-prompt" | "approval-page" | "host-permission" | "trusted-client" | "test";
/**
 * client-ui: the client's own dialog answered (the client's elicitation dialog, or the terminal's for the CLI). The agent
 * cannot write that answer through Praxis; it is a client response, not independently authenticated (approval-audit.ts).
 * The others are what released 0.1.0-alpha.48 to alpha.49.1 recorded and are read for what they were:
 * approval-page: a click in a page the Runtime served on 127.0.0.1. Anything running as the user can operate such a page,
 * so it is the test source's mechanism only (docs/approval-threat-model.md).
 * host-prompt and trusted-client: standing permissions switched on by PRAXIS_APPROVAL_MODE, which a repository's Claude
 * Code settings could set (T18). Removed.
 */
export type ApprovalAssurance = "client-ui" | "approval-page" | "host-prompt" | "trusted-client";

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
 * approve / reject / dismiss: what the channel that was asked answered (the client's dialog; in the test source only, the
 * approval page). It is the channel's answer: Praxis cannot tell whether a person or automation produced it.
 * unavailable: there was no way to ask on this connection, so nobody decided. `automatic` says the client answered by
 * itself (for example `decline` a few milliseconds after it was asked, with no dialog on screen): that is the client's
 * answer, never the user's. The request is then handled as a client with no dialog, never as a yes or a no.
 */
export type AskAnswer = {
  answer: "approve" | "reject" | "dismiss" | "unavailable";
  reason?: string;
  evidence?: AnswerEvidence;
  automatic?: "accept" | "decline" | "cancel";
  /** The channel wrote this decision to the journal itself (the test-source approval page logs its click). */
  journaled?: true;
  /**
   * Which channel actually answered, when a channel hands a request to another (in the test source, the client dialog hands
   * a client that answers by itself to the approval page). The approval is labelled with this, never with the wrapper's.
   * (Trusted Client and host-permission, which did this in 0.1.0-alpha.48 to alpha.49.1, are removed.)
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
  /** The channel that answered, as the journal names it (client-dialog, terminal-prompt ...). Never a person. */
  decidedBy: DecidedBy;
  /** Always false: Praxis cannot verify that a person, rather than automation, answered the channel. */
  personVerified: false;
  /** Always false: no approval authority independent of the user's own computer exists in this release. */
  independentlyVerified: false;
  assurance: ApprovalAssurance;
  decidedAt: string;
  reason?: string;
}>;

/** The labels every approval record, journal entry and protected-action result carries. */
export type ApprovalLabels = { channel: ApprovalChannelKind | "none"; decidedBy: DecidedBy; personVerified: false; independentlyVerified: false };

/** A dialog answer is never verified identity: these two are false on everything Praxis records or returns. */
export const approvalLabels = (channel: ApprovalChannelKind | "none", decidedBy: DecidedBy): ApprovalLabels => ({ channel, decidedBy, personVerified: false, independentlyVerified: false });

// A UserApproval is only real if this module made it. Parsed JSON, a tool argument or a look-alike object is not in
// this set, so no data an agent can send is ever mistaken for an approval.
const issued = new WeakSet<object>();

export const subjectDigest = (subject: string): string => `sha256:${createHash("sha256").update(subject, "utf8").digest("hex")}`;

const assuranceOf = (channel: ApprovalChannelKind): ApprovalAssurance =>
  channel === "host-permission" ? "host-prompt" : channel === "trusted-client" ? "trusted-client" : channel === "approval-page" ? "approval-page" : "client-ui";

/**
 * Codes for an action that did not run, one per outcome, so none is mistaken for another:
 *   APPROVAL_REJECTED            the channel that was asked answered reject (the client's dialog; the approval page in the
 *                                test source only)
 *   APPROVAL_DISMISSED           the dialog was closed without a decision
 *   APPROVAL_WITHDRAWN           the agent stopped it (confirmation=NO): no decision of the user is claimed
 *   APPROVAL_PENDING             the test-source approval page is open and nobody has decided yet (a shipped Runtime has no page)
 *   APPROVAL_TIMED_OUT           a dialog was shown and nobody answered in time
 *   APPROVAL_EXPIRED             an answer or a page request is too old to use
 *   APPROVAL_CLIENT_UI_REQUIRED  there is no way to ask here (no dialog, or the client answered by itself)
 *   DECISION_LEDGER_UNAVAILABLE  Praxis's security state (decision journal, decision ledger) has no safe location: it would
 *                                be inside the repository being operated on, or the account home cannot be determined
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
  | "APPROVAL_TOO_LARGE"
  | "DECISION_LEDGER_UNAVAILABLE";

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
  // never in a shipped Runtime: PRAXIS_BUNDLE_KIND is a constant there, so no environment (a repository's settings) enables it
  if (input.channel === "test" && (process.env.PRAXIS_TEST_APPROVALS !== "1" || process.env.PRAXIS_BUNDLE_KIND === "production")) {
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
    decidedBy: decidedByFor(input.channel),
    personVerified: false as const,
    independentlyVerified: false as const,
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
export function approvalModeReport(): { mode: "client-ui" | "no-dialog"; note: string; personVerified: false; independentlyVerified: false } {
  const channel = currentApprovalChannel();
  if (channel && channel.kind !== "host-permission" && channel.kind !== "trusted-client" && channel.kind !== "approval-page") {
    return {
      mode: "client-ui",
      note: "Protected actions run only when the client's own approval dialog answers approve for exactly that action. That answer is a client response, which the agent cannot write through Praxis's tools; it is not verified approval by a person: Praxis cannot tell whether a person or automation answered, and a program running as the user can run its own MCP client and answer it.",
      personVerified: false,
      independentlyVerified: false,
    };
  }
  return {
    mode: "no-dialog",
    note: "This client cannot show an approval dialog (no MCP elicitation support). Read-only tools and previews work; protected actions (Git, Jira, confirming a Story or decision, Quality fixes) are NOT executed, because nothing the agent says can stand in for an answer in the client's dialog. Use a client that supports elicitation.",
    personVerified: false,
    independentlyVerified: false,
  };
}

// --- decision log --------------------------------------------------------------------------------------------------

/**
 * What happened to one request, in the journal. Only approved / rejected / dismissed came from a channel that answered, and
 * then decidedBy names that channel (client-dialog, terminal-prompt; approval-page in earlier versions and the test source)
 * and personVerified and independentlyVerified are false: Praxis knows which channel answered, never that a person (rather
 * than automation driving that channel) did. Entries written before journal v2 have no decidedBy; see decision-journal.ts
 * for how they are read and amended.
 *   pending        the test-source approval page is open, nobody decided yet
 *   refused        also: Praxis's security state would be inside the repository (DECISION_LEDGER_UNAVAILABLE)
 *   timed-out      a dialog was shown and nobody answered in time
 *   expired        a page request or an answer became too old to use
 *   withdrawn      the agent stopped the action (confirmation=NO)
 *   auto-answered  the client answered without showing anything to the user
 *   unavailable    there was no way to ask the user
 *   refused        Praxis refused before asking (a stale plan, too large, a mismatched scope)
 */
export type DecisionOutcome = "approved" | "rejected" | "dismissed" | "pending" | "timed-out" | "expired" | "withdrawn" | "auto-answered" | "unavailable" | "refused";
/**
 * What produced the outcome. A client response: client-dialog (the client's approval dialog) or terminal-prompt (the CLI).
 * Otherwise: the client by itself, the agent, Praxis, nobody, or what earlier versions and the test source recorded
 * (approval-page: a click in a page served on loopback; trusted-client, host-prompt: standing permissions). None of these
 * names a verified person, and a page on loopback is never the user's channel.
 */
export type DecidedBy = "client-dialog" | "approval-page" | "terminal-prompt" | "client" | "agent" | "praxis" | "trusted-client" | "host-prompt" | "nobody";

/** The channels whose answer is a client response: the user's decision as far as Praxis can know, never a proven person. */
export const USER_CHANNELS: ReadonlySet<DecidedBy> = new Set(["client-dialog", "terminal-prompt"]);

export type DecisionLogEntry = {
  at: string;
  action: string;
  summary: string;
  subjectDigest: string;
  decision: DecisionOutcome;
  channel: ApprovalChannelKind | "none";
  /** Journal format: 2 adds decidedBy and evidence. Absent on entries written before. */
  v?: 2;
  /** Always written since journal v2; absent only on older entries. */
  decidedBy?: DecidedBy;
  /** Always false when present: Praxis cannot verify that a person, rather than automation, answered a user channel. */
  personVerified?: false;
  /** Always false when present (written since 0.1.0-alpha.49.3): no independent approval authority exists. */
  independentlyVerified?: false;
  evidence?: AnswerEvidence;
  reason?: string;
  /** The repository the decision was about (kept in the entry, not in the repository). */
  repository?: string;
};

const decidedByFor = (channel: ApprovalChannelKind): DecidedBy =>
  channel === "trusted-client" ? "trusted-client" : channel === "host-permission" ? "host-prompt" : channel === "approval-page" ? "approval-page" : channel === "terminal-prompt" ? "terminal-prompt" : "client-dialog";

// --- where security state lives -------------------------------------------------------------------------------------

/**
 * The home of Praxis's security state (the decision journal here; the decision ledger): `<account home>/.praxis`, with the
 * account home read from the OS account database (os.userInfo), never from HOME or PRAXIS_STATE_HOME.
 *
 * Tier: T-repo. A repository's `.claude/settings.json` `env` block (and an `.mcp.json` server entry) reaches the Runtime's
 * environment, so no environment variable may move this location in a shipped bundle. The test override PRAXIS_STATE_HOME
 * is honoured only when the build is not a shipped one (PRAXIS_BUNDLE_KIND is the constant "production" there, the same
 * gate as createUserApproval). It does not stop T-sandboxed-agent from reading these files, nor T-same-user from writing
 * them: anything stored on the user's account is writable by a program running as the user.
 *
 * Throws when the account home cannot be read from the account database (callers fail closed).
 */
export function securityStateHome(): string {
  if (process.env.PRAXIS_BUNDLE_KIND !== "production") {
    const override = process.env.PRAXIS_STATE_HOME?.trim();
    if (override) return resolve(override);
  }
  const home = userInfo().homedir;
  if (!home) throw new ApprovalError("DECISION_LEDGER_UNAVAILABLE", "the account home cannot be read from the OS account database, so Praxis has no place for its security state");
  return join(home, ".praxis");
}

const realOrResolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The nearest existing ancestor's real path, plus the rest: a location that does not exist yet still resolves through links. */
function realLocation(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      const up = dirname(current);
      if (up === current) return resolve(path);
      rest.unshift(basename(current));
      current = up;
    }
  }
}

/** The git directory a `.git` entry names: the folder itself, or the `gitdir:` of a worktree's `.git` file. */
function gitDirOf(dotGit: string): string | undefined {
  try {
    const st = lstatSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (st.isFile()) {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
      return named ? resolve(dirname(dotGit), named) : undefined;
    }
  } catch {
    /* not a git entry */
  }
  return undefined;
}

/**
 * The repository a path belongs to, independent of how the caller spelled it: the git common directory (shared by every
 * worktree of one clone) found by walking up from the real path, or the real path itself for a folder outside git.
 * `roots` are the folders that are "the repository" for the inside-the-repository rule: the real path, the work tree
 * that contains it and the main work tree of a linked worktree.
 */
export function repositoryIdentity(repo: string): { key: string; kind: "git" | "directory"; root: string; roots: string[] } {
  const real = realOrResolved(repo);
  let dir = real;
  for (;;) {
    const gitDir = gitDirOf(join(dir, ".git"));
    if (gitDir) {
      let common = gitDir;
      try {
        const named = readFileSync(join(gitDir, "commondir"), "utf8").trim();
        if (named) common = resolve(gitDir, named);
      } catch {
        /* a main work tree: its git directory is the common one */
      }
      const commonReal = realOrResolved(common);
      const mainTree = basename(commonReal) === ".git" ? dirname(commonReal) : undefined;
      return {
        key: createHash("sha256").update(`git:${commonReal}`).digest("hex"),
        kind: "git",
        root: dir,
        roots: [...new Set([real, dir, ...(mainTree ? [mainTree] : [])])],
      };
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { key: createHash("sha256").update(`dir:${real}`).digest("hex"), kind: "directory", root: real, roots: [real] };
}

/** A key for one repository: sha256 of the real path of its git common directory (or of its real path outside git). */
export const repositoryKey = (repo: string): string => repositoryIdentity(repo).key;

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/**
 * The security state home when it resolves inside the repository being operated on (through links too), else undefined.
 * Tier: T-repo and T-sandboxed-agent: either can write the repository, so state kept there is theirs to edit. Reads and
 * writes of security state there are refused, not only protected actions.
 */
export function securityStateInsideRepository(repo: string, home?: string): string | undefined {
  let location: string;
  try {
    location = realLocation(home ?? securityStateHome());
  } catch {
    return undefined; // no home at all is reported by securityStateHome's own refusal
  }
  return repositoryIdentity(repo).roots.some((root) => within(location, root)) ? location : undefined;
}

/** Throws DECISION_LEDGER_UNAVAILABLE when Praxis has no safe place for security state for this repository. */
export function assertSecurityStateOutside(repo: string): string {
  const home = securityStateHome();
  const inside = securityStateInsideRepository(repo, home);
  if (inside) {
    throw new ApprovalError(
      "DECISION_LEDGER_UNAVAILABLE",
      `Praxis's security state (the decision journal and ledger) would be inside the repository being operated on (${inside}), where the repository's own contents can edit it. It is neither read nor written there, and protected actions are refused. Nothing was changed.`,
      { executed: false, outcome: "refused", ...approvalLabels("none", "praxis"), stateHome: inside },
    );
  }
  return home;
}

/**
 * Where the decision journal lives: `<security state home>/decisions/<repository key>.jsonl`, outside the repository, keyed
 * by the repository's identity (repositoryKey), not by how the caller spelled the path. The journal is a log for the
 * user's later review, never evidence: nothing in Praxis reads it to decide whether an action may run.
 */
export function decisionLogPath(repo: string): string {
  return join(securityStateHome(), "decisions", `${repositoryKey(repo)}.jsonl`);
}

/**
 * Journals written before 0.1.0-alpha.49.3 were named after the path as the caller spelled it (sha256(path.resolve(repo)),
 * 16 hex characters). The first time a repository's journal is used, such a file in the same home is copied to the
 * repository's journal and the old file is left as it was, so the review (praxis_approval_journal) and its amendments still
 * see the earlier entries. The journal is a log, never evidence: where an old line came from decides nothing.
 */
export function adoptLegacyDecisionLog(repo: string): void {
  const path = decisionLogPath(repo);
  if (existsSync(path)) return;
  const legacy = join(dirname(path), `${createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 16)}.jsonl`);
  if (!existsSync(legacy)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  copyFileSync(legacy, path, fsConstants.COPYFILE_EXCL);
  chmodSync(path, 0o600);
}

/**
 * Best effort: the journal is for the user's later review; a write failure never changes a decision. Never written inside
 * the repository being operated on (obtainUserApproval refuses the action before that).
 */
export function logDecision(repo: string | undefined, entry: DecisionLogEntry & { decidedBy: DecidedBy }): void {
  if (!repo) return;
  try {
    if (securityStateInsideRepository(repo)) return;
    adoptLegacyDecisionLog(repo);
    const path = decisionLogPath(repo);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify({ v: 2, ...entry, personVerified: false, independentlyVerified: false, repository: repositoryIdentity(repo).root })}\n`, { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

// --- asking ------------------------------------------------------------------------------------------------------

/** Where the person answered, in words for a result message. */
const whereAsked = (kind: ApprovalChannelKind): string =>
  kind === "approval-page" ? "the Praxis approval page (test source)" : kind === "terminal-prompt" ? "the terminal prompt" : "the client's approval dialog";

/** The journal outcome for a refusal a channel raised itself, so a timeout or an open page is never logged as a "no". */
const OUTCOME_OF_CODE: Partial<Record<ApprovalErrorCode, { decision: DecisionOutcome; decidedBy: DecidedBy }>> = {
  APPROVAL_PENDING: { decision: "pending", decidedBy: "nobody" },
  APPROVAL_TIMED_OUT: { decision: "timed-out", decidedBy: "nobody" },
  APPROVAL_EXPIRED: { decision: "expired", decidedBy: "nobody" },
  APPROVAL_CLIENT_UI_REQUIRED: { decision: "unavailable", decidedBy: "nobody" },
};

/**
 * Gets the answer of the client's approval dialog for exactly this request, or throws before anything runs. Every refusal
 * carries `details.outcome`, `details.channel`, `details.decidedBy`, `personVerified: false` and `independentlyVerified:
 * false`, and the journal records the same, so a caller never has to guess:
 *   rejected in a user channel             -> APPROVAL_REJECTED   (decidedBy that channel, with its evidence)
 *   the dialog was closed without deciding -> APPROVAL_DISMISSED  (decidedBy that channel; not a rejection)
 *   confirmation=NO                        -> APPROVAL_WITHDRAWN  (decidedBy "agent"; never recorded as the user's)
 *   nobody could be asked / client answered by itself -> APPROVAL_CLIENT_UI_REQUIRED (decidedBy "nobody" / "client")
 *   the test-source approval page is open  -> APPROVAL_PENDING    (raised by that channel; decidedBy "nobody")
 *   security state inside the repository   -> DECISION_LEDGER_UNAVAILABLE (decidedBy "praxis"; nobody is asked)
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
      { executed: false, outcome: "withdrawn", ...approvalLabels("none", "agent"), rejected: false, dismissed: false },
    );
  }
  // Fails closed before anyone is asked: state the repository can edit is no place to record what was decided (T-repo).
  if (options.repo) {
    try {
      assertSecurityStateOutside(options.repo);
    } catch (error) {
      if (error instanceof ApprovalError) Object.assign(error.details, previewDetails(request));
      throw error;
    }
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
        error.details.channel ??= raisedBy;
        error.details.decidedBy ??= known.decidedBy;
        error.details.personVerified = false;
        error.details.independentlyVerified = false;
        error.details.executed ??= false;
        delete error.details.journaled;
        throw error;
      }
      logDecision(options.repo, { ...base, decision: "refused", decidedBy: "praxis", channel: channel.kind, reason: error instanceof Error ? error.message : String(error) });
      throw new ApprovalError("APPROVAL_REQUIRED", `the client could not ask for approval: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`, { ...previewDetails(request), outcome: "refused", ...approvalLabels(channel.kind, "praxis") });
    }
  }
  if (channel && answer && answer.answer !== "unavailable") {
    // labelled with the channel that answered, not the one that was asked (a wrapper may hand a request on)
    const answeredBy = answer.channel ?? channel.kind;
    const decidedBy = decidedByFor(answeredBy);
    const said = { ...approvalLabels(answeredBy, decidedBy), ...(answer.evidence ? { evidence: answer.evidence } : {}), ...(answer.reason ? { reason: answer.reason } : {}) };
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
    const details = { executed: false, outcome: dismissed ? "dismissed" : "rejected", ...approvalLabels(answeredBy, decidedBy), ...(answer.evidence ? { evidence: answer.evidence } : {}), ...(answer.reason ? { reason: answer.reason } : {}), rejected: !dismissed, dismissed };
    if (dismissed) {
      throw new ApprovalError("APPROVAL_DISMISSED", `${request.summary} was not run: ${whereAsked(answeredBy)} was closed without a decision. Nothing was changed. This is not a rejection; ask the user whether to try again.`, details);
    }
    throw new ApprovalError("APPROVAL_REJECTED", `${request.summary} was rejected in ${whereAsked(answeredBy)}. Nothing was changed.`, details);
  }
  const automatic = answer?.automatic;
  const why = automatic
    ? `the client answered "${automatic}" ${answer?.evidence?.latencyMs ?? "?"} ms after it was asked, faster than a person can read the request${answer?.reason ? ` (${answer.reason})` : ""}; that is the client's answer, not the user's`
    : answer?.reason ?? "this client cannot show an approval dialog (no MCP elicitation support)";
  const unansweredChannel = answer?.channel ?? channel?.kind ?? "none";
  logDecision(options.repo, {
    ...base,
    decision: automatic ? "auto-answered" : "unavailable",
    decidedBy: automatic ? "client" : "nobody",
    channel: unansweredChannel,
    ...(answer?.evidence ? { evidence: answer.evidence } : {}),
    reason: why.slice(0, 300),
  });
  throw new ApprovalError(
    "APPROVAL_CLIENT_UI_REQUIRED",
    `${request.summary} was NOT executed, and nobody rejected it: Praxis could not ask through a client dialog (${why}). Show the user the preview below. It can be applied where Praxis can ask: a client whose approval dialog is shown (for example the Claude Code CLI in a terminal). The agent's or the user's text in chat, a page and any setting are not accepted as approval, and trying again here gives the same answer. Read-only tools still work.`,
    { ...previewDetails(request), outcome: automatic ? "auto-answered" : "unavailable", ...approvalLabels(unansweredChannel, automatic ? "client" : "nobody"), ...(answer?.evidence ? { evidence: answer.evidence } : {}), ...(automatic ? { automatic } : {}) },
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
    throw new ApprovalError("APPROVAL_SCOPE_MISMATCH", `this approval is not for ${expected.action} as it is now: the content differs from what the approval dialog showed`);
  }
  const age = (expected.now ?? new Date()).getTime() - Date.parse(approval.decidedAt);
  if (!Number.isFinite(age) || age > USER_APPROVAL_TTL_MS || age < -60_000) {
    throw new ApprovalError("APPROVAL_EXPIRED", "the approval is too old; ask again");
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
    throw new ApprovalError("APPROVAL_REQUIRED", "direct mutation is not authorized: no approval was given for it. It must run through a Praxis apply tool, after the client's approval dialog approves it");
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
