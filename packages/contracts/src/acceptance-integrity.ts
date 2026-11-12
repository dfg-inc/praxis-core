import { createHash } from "node:crypto";
import { WorkflowError } from "./errors.js";
import { ACCEPTABLE_PHASES, type AcceptablePhase, type Prototype, type StoryPlan } from "./planning-schemas.js";
import type { UserStory } from "./story.js";
import type { WorkflowState } from "./workflow.js";

/**
 * Acceptance integrity (R2): which of the acceptances a Work Item file claims Praxis can stand behind.
 *
 * A Work Item lives in the repository (.praxis/workflow/items/<id>.json). Its acceptance fields (a criterion's review
 * status, a phase acceptance, a confirmed story or decision, an approved service, an agreed contract, a waiver, classic
 * mode) are plain JSON: whoever can write the repository can write "accepted". So the file is never the evidence. Every
 * acceptance Praxis records is ALSO appended to a decision ledger outside the repository (the Runtime's decision-ledger.ts:
 * ~/.praxis/ledger/<repository key>/<work item>.jsonl, from the OS account database, never from HOME or the repository),
 * written only by the Runtime's own write path after the client's approval dialog answered in that same call, and bound
 * to the subject's exact content (contentDigest) and to a random actionId that the file stores next to its claim.
 *
 * Reading a Work Item, the Runtime compares each claim with the ledger and annotates the in-memory state (never the file):
 *   accepted    a ledger record matches this subject and this exact content, and is the latest decision for the subject
 *   unverified  the file claims it and nothing here backs it: recorded before 0.1.0-alpha.49.3, on another clone or
 *               computer, or written into the file
 *   invalid     the ledger contradicts the file: the content changed after acceptance, the latest decision for the
 *               subject is a reject/revoke/supersede, the record belongs to another subject (copied), or the id is not unique
 *   stale       accepted for an earlier revision that a later Praxis revision superseded (the existing staleness rules)
 *   independently-verified  reserved; never produced. No approval authority exists in this release, so anything that would
 *               need it fails closed with INDEPENDENT_AUTHORITY_UNAVAILABLE.
 * Gates, readiness, verdicts, summaries and guidance read acceptance through the accessors below: only "accepted" counts.
 *
 * Which tier this stops (BRIEF threat tiers):
 *   T-repo             cannot write the ledger (outside the repository; its location ignores repository settings and the
 *                      environment in a shipped bundle), so a forged or copied claim reads unverified or invalid.
 *   T-sandboxed-agent  can read the ledger but not write it (outside the workspace); a Praxis bundle it starts inside its
 *                      sandbox cannot append to it either, so an acceptance it obtains from its own client fails closed.
 *   T-same-user        NOT stopped. A program with the user's OS privileges can append to the ledger (recomputing the hash
 *                      chain), or answer the client's dialog itself (R1). "accepted" therefore means "recorded by Praxis on
 *                      this computer after the client's dialog answered", never "a person decided".
 *
 * In-memory rule: a state WITHOUT the annotation is a trusted in-memory state. Only the Runtime's workflow store reads Work
 * Item files, and it always annotates (readItem); core unit tests build states with the reducers, whose user decisions
 * are verified in the same call. A state WITH the annotation counts a claim only when its entry says "accepted", or when
 * the claim has no entry because it was made in this very call by a verified decision (the reducer clears the entry).
 */

export const INTEGRITY_STATUSES = ["proposed", "accepted", "unverified", "invalid", "stale", "independently-verified"] as const;
export type IntegrityStatus = (typeof INTEGRITY_STATUSES)[number];

export const SUBJECT_KINDS = ["criterion", "phase", "story", "decision", "service", "contract", "waiver", "mode"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export type SubjectRef = { kind: SubjectKind; id: string; revision?: number };
export const subjectKey = (kind: SubjectKind, id: string): string => `${kind}:${id}`;

export const LEDGER_DECISIONS = ["accept", "reject", "revoke", "supersede"] as const;
export type LedgerDecision = (typeof LEDGER_DECISIONS)[number];

export const ACCEPTANCE_UNVERIFIED = "ACCEPTANCE_UNVERIFIED";
export const ACCEPTANCE_INVALID = "ACCEPTANCE_INVALID";
export const DECISION_LEDGER_UNAVAILABLE = "DECISION_LEDGER_UNAVAILABLE";
export const INDEPENDENT_AUTHORITY_UNAVAILABLE = "INDEPENDENT_AUTHORITY_UNAVAILABLE";

/** What "accepted" means, in words a reader of status or inspect gets next to the counts. */
export const ACCEPTANCE_INTEGRITY_NOTE =
  "accepted = recorded by Praxis on this computer (in its decision ledger, outside the repository) after the MCP client's approval dialog answered for exactly this content. That is a client response, not proof that a person decided: a program running as the same OS user can answer the dialog or write the ledger. unverified = the work item file claims an acceptance that nothing on this computer backs (made before 0.1.0-alpha.49.3, on another clone or computer, or written into the file). invalid = the ledger contradicts the file (content changed after acceptance, a later rejection, revocation or revision, or a record copied from another subject). stale = accepted for an earlier revision. Only accepted counts for gates; re-accept the others through the normal review, where the content is shown. No acceptance is independently verified in this release.";

// --- canonical content and digests ---------------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k.normalize("NFC"))}:${canonical(v)}`).join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  return JSON.stringify(value ?? null);
}

/** sha256 of canonical JSON (sorted keys, NFC strings, undefined dropped). */
export function contentDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

// The review fingerprints below predate the ledger (16 hex digits, localeCompare key order). They are kept exactly as
// they were: saved phase acceptances carry them, and "stale" is defined by them.
export function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)]),
    );
  }
  return value;
}
export const fingerprint16 = (value: unknown): string => createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex").slice(0, 16);

export const activeRequirements = (state: WorkflowState) => state.requirements.filter((r) => r.status !== "superseded");
export const activeStories = (state: WorkflowState) => state.stories.filter((s) => s.status !== "superseded" && s.status !== "excluded");

/** Content of the requirements a user reviews (not their review marks, so marking does not invalidate acceptance). */
function requirementsReviewFields(state: WorkflowState) {
  return activeRequirements(state).map((r) => ({
    id: r.id,
    statement: r.statement,
    scope: r.scope,
    ac: r.acceptanceCriteria.map((c) => ({ id: c.id, statement: c.statement })),
  }));
}

/**
 * Interaction fields added after alpha.49 default to empty. An empty value is dropped before hashing, so a prototype saved
 * before they existed keeps the fingerprint its acceptance was recorded with (no silent "changed since you accepted it").
 */
const EMPTY_ELEMENT_DEFAULTS: Record<string, unknown> = { options: [], filters: [], detailFields: [], tabs: [], related: [], required: false };
export function prototypeContent(prototype: Prototype): unknown {
  const { feedback: _f, history: _h, status: _s, revision: _r, ...content } = prototype;
  const { datasets, scenarios, limitations, screens, ...rest } = content;
  const out: Record<string, unknown> = { ...rest };
  if (datasets?.length) out.datasets = datasets;
  if (scenarios?.length) out.scenarios = scenarios;
  if (limitations?.length) out.limitations = limitations;
  out.screens = screens.map((screen) => ({
    ...screen,
    elements: screen.elements.map((element) => {
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(element)) {
        if (value === undefined) continue;
        const dflt = EMPTY_ELEMENT_DEFAULTS[key];
        if (key in EMPTY_ELEMENT_DEFAULTS && JSON.stringify(dflt) === JSON.stringify(value)) continue;
        kept[key] = value;
      }
      return kept;
    }),
  }));
  return out;
}

/** Detailing a planned story does not change the plan the user agreed to; excluding one does. */
export function storyPlanContent(plan: StoryPlan): unknown {
  return plan.entries.map(({ review: _r, status, excludedReason, ...entry }) => ({ ...entry, excluded: status === "excluded", ...(status === "excluded" && excludedReason !== undefined ? { excludedReason } : {}) }));
}

/** What the stories review shows of one story. */
export function storyReviewContent(s: UserStory) {
  return {
    id: s.id,
    revision: s.revision,
    requirementIds: s.requirementIds,
    narrative: s.narrative,
    ac: s.acceptanceCriteria,
    happyPath: s.happyPath,
    alternatives: s.alternatives,
    negative: s.negative,
    edgeCases: s.edgeCases,
    businessRules: s.businessRules,
    expectedResults: s.expectedResults,
  };
}

export function requirementsFingerprint(state: WorkflowState): string {
  return fingerprint16(requirementsReviewFields(state));
}

/** What the user agrees to when they agree a contract: its content, not its status. */
export function contractsFingerprint(state: WorkflowState): string {
  return fingerprint16(state.contracts.map(({ status: _s, agreement: _a, everAgreed: _e, ...content }) => content));
}

export function prototypeFingerprint(prototype: Prototype | undefined): string {
  if (!prototype) return "none";
  return fingerprint16(prototypeContent(prototype));
}

export function storyPlanFingerprint(plan: StoryPlan | undefined): string {
  if (!plan) return "none";
  return fingerprint16(storyPlanContent(plan));
}

export function storiesFingerprint(state: WorkflowState): string {
  return fingerprint16(activeStories(state).map(storyReviewContent));
}

export function currentFingerprint(state: WorkflowState, phase: AcceptablePhase): string {
  if (phase === "requirements_review") return requirementsFingerprint(state);
  if (phase === "prototype") return prototypeFingerprint(state.prototype);
  if (phase === "story_plan") return storyPlanFingerprint(state.storyPlan);
  return storiesFingerprint(state);
}

// Ledger content per subject kind. Status, review marks, times and channels are never content: they are what the
// decision is about. Location fields of a service (localPath, repository, branch ...) are machine-specific and change
// legitimately without a new decision, so they are not bound either.

type Criterion = WorkflowState["requirements"][number]["acceptanceCriteria"][number];
export const criterionContent = (requirementId: string, c: Criterion) => ({ kind: "criterion", id: c.id, requirementId, revision: c.revision, statement: c.statement });

/** Phase acceptance binds the digests of the subjects it covers, so a phase cannot stay accepted over changed parts. */
export function phaseContent(state: WorkflowState, phase: AcceptablePhase): unknown {
  switch (phase) {
    case "requirements_review":
      return {
        kind: "phase",
        phase,
        requirements: activeRequirements(state).map((r) => ({ id: r.id, statement: r.statement, scope: r.scope, criteria: r.acceptanceCriteria.map((c) => contentDigest(criterionContent(r.id, c))) })),
      };
    case "prototype":
      return { kind: "phase", phase, prototype: state.prototype ? prototypeContent(state.prototype) : null };
    case "story_plan":
      return { kind: "phase", phase, plan: state.storyPlan ? storyPlanContent(state.storyPlan) : null };
    default:
      return { kind: "phase", phase, stories: activeStories(state).map((s) => contentDigest(storyReviewContent(s))) };
  }
}

export const storyContent = (s: UserStory) => ({
  kind: "story",
  id: s.id,
  revision: s.revision,
  requirementIds: s.requirementIds,
  actor: s.actor,
  narrative: s.narrative,
  objective: s.objective,
  userValue: s.userValue,
  preconditions: s.preconditions,
  happyPath: s.happyPath,
  alternatives: s.alternatives,
  negative: s.negative,
  edgeCases: s.edgeCases,
  businessRules: s.businessRules,
  acceptanceCriteria: s.acceptanceCriteria,
  expectedResults: s.expectedResults,
  assumptionIds: s.assumptionIds,
});

type Decision = WorkflowState["decisions"][number];
export const decisionContent = (d: Decision) => ({ kind: "decision", id: d.id, revision: d.revision, statement: d.statement, rationale: d.rationale ?? null, notes: d.notes ?? null });

type Service = WorkflowState["services"][number];
export const serviceContent = (s: Service) => ({ kind: "service", id: s.id, name: s.name, serviceKind: s.kind, responsibilities: s.responsibilities, requirementIds: s.requirementIds, dependsOn: s.dependsOn, status: s.status });

type Contract = WorkflowState["contracts"][number];
export function contractContent(c: Contract) {
  const { status: _s, agreement: _a, everAgreed: _e, ...content } = c;
  return { kind: "contract", ...content };
}

type Waiver = WorkflowState["waivers"][number];
export const waiverContent = (w: Waiver) => ({ kind: "waiver", id: w.id, waived: w.kind, requirementId: w.requirementId ?? null, reason: w.reason });

// --- the subjects a Work Item claims --------------------------------------------------------------------------------

export type AcceptanceSubject = SubjectRef & {
  key: string;
  /** The file says this subject is accepted (confirmed, approved, agreed, waived, classic). */
  claimed: boolean;
  contentDigest: string;
  label: string;
  /** Stale by the rule that predates the ledger: a phase whose content no longer has the fingerprint it was accepted with. */
  stale: boolean;
};

/** Every stored field a gate, readiness check, verdict or summary trusts as a person's decision. */
export function acceptanceSubjects(state: WorkflowState): AcceptanceSubject[] {
  const out: AcceptanceSubject[] = [];
  const add = (kind: SubjectKind, id: string, claimed: boolean, content: unknown, label: string, revision?: number, stale = false) =>
    out.push({ kind, id, key: subjectKey(kind, id), claimed, contentDigest: contentDigest(content), label, ...(revision !== undefined ? { revision } : {}), stale });
  for (const r of activeRequirements(state)) {
    for (const c of r.acceptanceCriteria) add("criterion", c.id, c.review.status === "accepted", criterionContent(r.id, c), `acceptance criterion ${c.id}`, c.revision);
  }
  for (const phase of ACCEPTABLE_PHASES) {
    const acceptance = state.phaseAcceptance?.[phase] as { revision: number; fingerprint?: string } | undefined;
    if (!acceptance) continue;
    add("phase", phase, true, phaseContent(state, phase), `${phase} acceptance`, acceptance.revision, acceptance.fingerprint !== currentFingerprint(state, phase));
  }
  for (const s of state.stories) {
    if (s.status === "superseded") continue;
    add("story", s.id, s.confirmedBehavior || s.status === "confirmed", storyContent(s), `story ${s.id} confirmation`, s.revision);
  }
  for (const d of state.decisions) add("decision", d.id, d.confirmed, decisionContent(d), `decision ${d.id} confirmation`, d.revision);
  for (const s of state.services) add("service", s.id, s.status === "approved" || s.status === "completed", serviceContent(s), `service ${s.id} approval (${s.status})`);
  for (const c of state.contracts ?? []) add("contract", c.id, c.status === "agreed", contractContent(c), `contract ${c.id} agreement`);
  for (const w of state.waivers ?? []) add("waiver", w.id, true, waiverContent(w), `waiver ${w.id} (${w.kind}${w.requirementId ? ` for ${w.requirementId}` : ""})`);
  // classic switches the stage gates off: the user's choice, so it is a claim like any acceptance
  add("mode", "mode", state.mode === "classic", { kind: "mode", mode: "classic" }, "classic mode (stage gates off)");
  return out;
}

// --- the ledger, as the Runtime reads it ----------------------------------------------------------------------------

export type LedgerApproval = {
  action: string;
  subjectDigest: string;
  channel: string;
  decidedBy: string;
  decidedAt: string;
  personVerified: false;
  independentlyVerified: false;
};

/** One line of ~/.praxis/ledger/<repository key>/<work item>.jsonl. Written only by the Runtime (decision-ledger.ts). */
export type LedgerEntry = {
  v: 1;
  seq: number;
  /** sha256 (hex) of the previous line as written; 64 zeros for the first. */
  prev: string;
  at: string;
  workItemId: string;
  subject: SubjectRef;
  contentDigest: string;
  decision: LedgerDecision;
  /** Random, unique, never reused. The Work Item file stores it next to the acceptance it backs (acceptanceActions). */
  actionId: string;
  batchId: string;
  /** The client's answer this decision rests on; null for a revision or revocation Praxis recorded without a decision. */
  approval: LedgerApproval | null;
  /** client-response: the client's approval dialog answered (never "independent": no approval authority exists). */
  assurance: "client-response" | "none";
};

export type LedgerReading =
  | { status: "available"; entries: readonly LedgerEntry[] }
  | { status: "unavailable" | "corrupt"; reason: string };

export type SubjectIntegrity = { key: string; kind: SubjectKind; id: string; label: string; status: Exclude<IntegrityStatus, "proposed">; reason: string; actionId?: string };

export type IntegrityAnnotation = {
  ledger: LedgerReading["status"];
  ledgerReason?: string;
  /** One entry per subject the file claims, as it was read. A claim made later in the same call has none (trusted). */
  subjects: Record<string, SubjectIntegrity>;
  /** approvals[] records of the file, by record id: accepted when a ledger record carries the same approval. */
  records: Record<string, "accepted" | "unverified">;
  independentVerification: "unavailable";
};

/** The in-memory property the store sets. Never part of the schema, stripped before every write. */
export const INTEGRITY_KEY = "acceptanceIntegrity";
type Annotated = WorkflowState & { [INTEGRITY_KEY]?: IntegrityAnnotation };

export function annotationOf(state: WorkflowState | null | undefined): IntegrityAnnotation | undefined {
  return state ? (state as Annotated)[INTEGRITY_KEY] : undefined;
}

export function withIntegrity<T extends WorkflowState>(state: T, annotation: IntegrityAnnotation): T {
  return { ...state, [INTEGRITY_KEY]: annotation } as T;
}

/** The state as it may be written: the annotation is never persisted. */
export function stripIntegrity<T extends WorkflowState>(state: T): T {
  if (!(INTEGRITY_KEY in state)) return state;
  const { [INTEGRITY_KEY]: _a, ...rest } = state as Annotated;
  return rest as T;
}

const GENESIS = "0".repeat(64);
export { GENESIS as LEDGER_GENESIS };

function judge(
  subject: AcceptanceSubject,
  actionId: string | undefined,
  ledger: LedgerReading,
  byAction: Map<string, LedgerEntry[]>,
  bySubject: Map<string, LedgerEntry[]>,
): { status: SubjectIntegrity["status"]; reason: string } {
  if (subject.stale) return { status: "stale", reason: "it changed after it was accepted (a later revision): accept it again" };
  if (ledger.status === "corrupt") return { status: "invalid", reason: `the decision ledger cannot be trusted: ${ledger.reason}` };
  if (ledger.status === "unavailable") return { status: "unverified", reason: `the decision ledger could not be read: ${ledger.reason}` };
  if (!actionId) return { status: "unverified", reason: "the file references no Praxis decision record (accepted before 0.1.0-alpha.49.3, or written into the file)" };
  const found = byAction.get(actionId) ?? [];
  if (found.length === 0) return { status: "unverified", reason: "no decision record on this computer matches it (made on another clone or computer, or written into the file)" };
  if (found.length > 1) return { status: "invalid", reason: `decision record ${actionId} appears ${found.length} times in the ledger` };
  const entry = found[0]!;
  const recorded = subjectKey(entry.subject.kind, entry.subject.id);
  if (recorded !== subject.key) return { status: "invalid", reason: `decision record ${actionId} belongs to ${recorded}, not to this subject (copied)` };
  if (entry.decision !== "accept") return { status: "invalid", reason: `decision record ${actionId} is a ${entry.decision}, not an acceptance` };
  const history = bySubject.get(subject.key) ?? [];
  const latest = history[history.length - 1];
  if (latest && latest.actionId !== entry.actionId) {
    // the latest decision wins. A later revision or acceptance Praxis recorded for the content the file now has is a legitimate
    // progression (stale); any other later decision contradicts the file's claim (invalid)
    if ((latest.decision === "supersede" || latest.decision === "accept") && latest.contentDigest === subject.contentDigest) {
      return { status: "stale", reason: `a later ${latest.decision === "accept" ? "acceptance" : "revision"} recorded by Praxis (${latest.at}) supersedes the acceptance this file references: accept it again` };
    }
    return { status: "invalid", reason: `the latest decision recorded for it is a ${latest.decision} (${latest.at}), which the file contradicts` };
  }
  if (entry.contentDigest !== subject.contentDigest) return { status: "invalid", reason: "its content changed after it was accepted, outside Praxis" };
  return { status: "accepted", reason: `recorded by Praxis on this computer at ${entry.at} after ${entry.approval?.decidedBy ?? "an approval"} answered (a client response; not proof a person decided)` };
}

/** Compares every claim of the file with the ledger. Pure: the Runtime reads the ledger and passes it in. */
export function evaluateIntegrity(state: WorkflowState, ledger: LedgerReading): IntegrityAnnotation {
  const entries = ledger.status === "available" ? ledger.entries.filter((e) => e.workItemId === state.workItem.id) : [];
  const byAction = new Map<string, LedgerEntry[]>();
  const bySubject = new Map<string, LedgerEntry[]>();
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    byAction.set(entry.actionId, [...(byAction.get(entry.actionId) ?? []), entry]);
    const key = subjectKey(entry.subject.kind, entry.subject.id);
    bySubject.set(key, [...(bySubject.get(key) ?? []), entry]);
  }
  const actions = state.acceptanceActions ?? {};
  const subjects: Record<string, SubjectIntegrity> = {};
  for (const subject of acceptanceSubjects(state)) {
    if (!subject.claimed) continue;
    const actionId = typeof actions[subject.key] === "string" ? actions[subject.key] : undefined;
    const verdict = judge(subject, actionId, ledger, byAction, bySubject);
    subjects[subject.key] = { key: subject.key, kind: subject.kind, id: subject.id, label: subject.label, ...verdict, ...(actionId ? { actionId } : {}) };
  }
  const records: IntegrityAnnotation["records"] = {};
  for (const record of state.approvals ?? []) {
    const backed = entries.some((e) => e.approval && record.subjectDigest && e.approval.subjectDigest === record.subjectDigest && e.approval.decidedAt === record.at);
    records[record.id] = backed ? "accepted" : "unverified";
  }
  return {
    ledger: ledger.status,
    ...(ledger.status !== "available" ? { ledgerReason: ledger.reason } : {}),
    subjects,
    records,
    independentVerification: "unavailable",
  };
}

// --- accessors: only "accepted" counts ----------------------------------------------------------------------------

/** Whether the claim on this subject counts. No annotation: a trusted in-memory state (see the rule at the top). */
export function isTrusted(state: WorkflowState, key: string): boolean {
  const entry = annotationOf(state)?.subjects[key];
  return entry === undefined || entry.status === "accepted";
}

/** The integrity of a claimed subject, or undefined when the claim counts (or there is none). */
export function untrustedClaim(state: WorkflowState, key: string): SubjectIntegrity | undefined {
  const entry = annotationOf(state)?.subjects[key];
  return entry && entry.status !== "accepted" ? entry : undefined;
}

/**
 * Called by a reducer when a decision verified in THIS call (re)accepts a subject: the claim it writes counts from now on in
 * memory, and the store records it in the ledger. Only reached behind verifyUserApproval or a verified review channel.
 */
export function clearIntegrity<T extends WorkflowState>(state: T, keys: readonly string[]): T {
  const annotation = annotationOf(state);
  if (!annotation || !keys.some((key) => key in annotation.subjects)) return state;
  const subjects = { ...annotation.subjects };
  for (const key of keys) delete subjects[key];
  return withIntegrity(state, { ...annotation, subjects });
}

/** The mode whose gates apply: classic only when that choice is backed by the ledger. */
export function enforcedMode(state: WorkflowState): WorkflowState["mode"] {
  return state.mode === "classic" && !isTrusted(state, subjectKey("mode", "mode")) ? "guided" : state.mode;
}

/**
 * The state as far as Praxis can stand behind it: every claim that is not "accepted" is taken back (a criterion is
 * undecided again, a story or decision unconfirmed, a service awaiting approval, a contract proposed, a waiver absent,
 * classic mode guided). For READING only (gates, readiness, verdicts, guidance, review pages): never written, so the
 * file's own claims stay as they are and stay visible.
 */
export function trustedView<T extends WorkflowState>(state: T): T {
  const annotation = annotationOf(state);
  if (!annotation || !Object.values(annotation.subjects).some((s) => s.status !== "accepted")) return state;
  const bad = (kind: SubjectKind, id: string) => !isTrusted(state, subjectKey(kind, id));
  const phaseAcceptance = { ...state.phaseAcceptance };
  // a stale phase acceptance stays: acceptanceStatus already reports it as stale, which says more than "missing"
  for (const phase of ACCEPTABLE_PHASES) if (phaseAcceptance[phase] && bad("phase", phase) && untrustedClaim(state, subjectKey("phase", phase))?.status !== "stale") delete phaseAcceptance[phase];
  return {
    ...state,
    mode: enforcedMode(state),
    requirements: state.requirements.map((r) =>
      r.acceptanceCriteria.some((c) => c.review.status === "accepted" && bad("criterion", c.id))
        ? { ...r, acceptanceCriteria: r.acceptanceCriteria.map((c) => (c.review.status === "accepted" && bad("criterion", c.id) ? { ...c, review: { ...c.review, status: "pending" as const } } : c)) }
        : r,
    ),
    phaseAcceptance,
    stories: state.stories.map((s) => ((s.confirmedBehavior || s.status === "confirmed") && s.status !== "superseded" && bad("story", s.id) ? { ...s, confirmedBehavior: false, status: s.status === "confirmed" ? ("proposed" as const) : s.status } : s)),
    decisions: state.decisions.map((d) => (d.confirmed && bad("decision", d.id) ? { ...d, confirmed: false } : d)),
    services: state.services.map((s) => ((s.status === "approved" || s.status === "completed") && bad("service", s.id) ? { ...s, status: "review_required" as const } : s)),
    contracts: (state.contracts ?? []).map((c) => (c.status === "agreed" && bad("contract", c.id) ? { ...c, status: "proposed" as const } : c)),
    waivers: (state.waivers ?? []).filter((w) => !bad("waiver", w.id)),
    ...(state.prototype && state.prototype.status === "accepted" && bad("phase", "prototype") ? { prototype: { ...state.prototype, status: "draft" as const } } : {}),
    ...(state.storyPlan && state.storyPlan.status === "agreed" && bad("phase", "story_plan") ? { storyPlan: { ...state.storyPlan, status: "draft" as const } } : {}),
  };
}

/** Per-subject integrity of every claim, for status and inspect. */
export function integrityReport(state: WorkflowState): Array<SubjectIntegrity> {
  const annotation = annotationOf(state);
  return acceptanceSubjects(state)
    .filter((s) => s.claimed)
    .map((s) => annotation?.subjects[s.key] ?? { key: s.key, kind: s.kind, id: s.id, label: s.label, status: s.stale ? ("stale" as const) : ("accepted" as const), reason: annotation ? "accepted in this call" : "in-memory state (not read from a file)" });
}

/** The summary every reader shows: counts by integrity, and that no acceptance is independently verified. */
export function integritySummary(state: WorkflowState): { integrity: { accepted: number; unverified: number; invalid: number; stale: number }; independentVerification: "unavailable" } {
  const integrity = { accepted: 0, unverified: 0, invalid: 0, stale: 0 };
  for (const entry of integrityReport(state)) if (entry.status in integrity) integrity[entry.status as keyof typeof integrity] += 1;
  return { integrity, independentVerification: "unavailable" };
}

/** A gate's words for a claim that does not count: the code and the subject, so a refusal says what to re-accept. */
export function integrityProblem(state: WorkflowState, key: string): { code: typeof ACCEPTANCE_UNVERIFIED | typeof ACCEPTANCE_INVALID; subject: string; status: string; text: string } | null {
  const entry = untrustedClaim(state, key);
  if (!entry || entry.status === "stale") return null;
  const code = entry.status === "invalid" ? ACCEPTANCE_INVALID : ACCEPTANCE_UNVERIFIED;
  return { code, subject: key, status: entry.status, text: `${code}: ${entry.label} is marked accepted in the work item file but ${entry.reason}; re-accept it through the review` };
}

/**
 * Nothing in this release can verify a person independently of the client's dialog. A caller that needs it gets a refusal,
 * never a weaker answer.
 */
export function requireIndependentVerification(what: string): never {
  throw new WorkflowError(INDEPENDENT_AUTHORITY_UNAVAILABLE, `${what} needs a decision verified independently of the MCP client's dialog; no such authority exists in this release, so it is not done`);
}

// --- what a write must append ---------------------------------------------------------------------------------------

export type PlannedLedgerEntry = { key: string; subject: SubjectRef; contentDigest: string; decision: LedgerDecision };

/** What the user's approval in this call covers (decision-ledger: only subjects the dialog showed get an acceptance). */
export type ApprovalCoverage = { covers(key: string): boolean };

/**
 * The ledger entries a write must append, from the state it read (annotated by the store) and the state it will write.
 *   accept     a claim made in this call by a decision verified in this call (a new claim, or one a verified reducer
 *              re-made and cleared) that the approval of this call covers, unless the ledger already backs this content
 *   reject     a criterion the user rejected in this call
 *   supersede  a recorded acceptance whose content changed (a revision)
 *   revoke     a recorded acceptance that is no longer claimed with the same content (withdrawn, removed, reopened)
 * A write without an approval never produces accept or reject: a claim it makes stays unverified.
 */
export function planLedgerEntries(pre: WorkflowState | null, post: WorkflowState, approval: ApprovalCoverage | null): PlannedLedgerEntry[] {
  const preAnnotation = annotationOf(pre);
  const postAnnotation = annotationOf(post);
  // a claim counts as made in this call only when its entry is gone: a state that lost the whole annotation would make every
  // claim look new, so that is refused instead
  if (pre && (!preAnnotation || !postAnnotation)) throw new WorkflowError(DECISION_LEDGER_UNAVAILABLE, "a write must start from a work item the store read and checked against the decision ledger");
  const before = new Map((pre ? acceptanceSubjects(pre) : []).map((s) => [s.key, s]));
  const after = new Map(acceptanceSubjects(post).map((s) => [s.key, s]));
  const recorded = (key: string) => before.get(key)?.claimed === true && preAnnotation?.subjects[key]?.status === "accepted";
  const madeNow = (key: string) => !postAnnotation || !(key in postAnnotation.subjects);
  const out: PlannedLedgerEntry[] = [];
  const plan = (s: AcceptanceSubject, decision: LedgerDecision) => out.push({ key: s.key, subject: { kind: s.kind, id: s.id, ...(s.revision !== undefined ? { revision: s.revision } : {}) }, contentDigest: s.contentDigest, decision });
  const criterionStatus = (state: WorkflowState | null, id: string) => state?.requirements.flatMap((r) => r.acceptanceCriteria).find((c) => c.id === id)?.review.status;
  for (const [key, s] of after) {
    const b = before.get(key);
    if (s.claimed) {
      if (recorded(key) && b!.contentDigest === s.contentDigest) continue;
      if (madeNow(key) && !s.stale && approval?.covers(key)) plan(s, "accept");
      else if (recorded(key)) plan(s, "supersede");
      continue;
    }
    if (s.kind === "criterion" && approval?.covers(key) && criterionStatus(post, s.id) === "rejected" && !(criterionStatus(pre, s.id) === "rejected" && b?.contentDigest === s.contentDigest)) {
      plan(s, "reject");
      continue;
    }
    if (recorded(key)) plan(b!.contentDigest !== s.contentDigest ? s : b!, b!.contentDigest !== s.contentDigest ? "supersede" : "revoke");
  }
  for (const [key, b] of before) if (!after.has(key) && recorded(key)) plan(b, "revoke");
  return out;
}

/**
 * The subjects a batch the user approved in the client's dialog can accept: what its commands name, judged against the
 * state the batch was applied to. Anything else a write claims stays unverified.
 */
export function batchCoverage(batch: ReadonlyArray<Record<string, unknown>>, pre: WorkflowState | null): ApprovalCoverage {
  const keys = new Set<string>();
  let newWaivers = false;
  for (const command of batch) {
    switch (command.action) {
      case "review-requirements": {
        for (const decision of (command.decisions as Array<{ acceptance?: Array<{ id: string; status?: string }> }>) ?? []) {
          for (const a of decision.acceptance ?? []) if (a.status !== undefined) keys.add(subjectKey("criterion", a.id));
        }
        keys.add(subjectKey("phase", "requirements_review"));
        break;
      }
      case "accept-requirements": {
        const ids = (command.requirementIds as string[] | undefined) ?? (pre ? activeRequirements(pre).filter((r) => r.scope === "in").map((r) => r.id as string) : []);
        for (const r of pre ? activeRequirements(pre) : []) if (ids.includes(r.id)) for (const c of r.acceptanceCriteria) keys.add(subjectKey("criterion", c.id));
        keys.add(subjectKey("phase", "requirements_review"));
        break;
      }
      case "accept-prototype":
        keys.add(subjectKey("phase", "prototype"));
        break;
      case "agree-story-plan":
        keys.add(subjectKey("phase", "story_plan"));
        break;
      case "accept-stories":
        keys.add(subjectKey("phase", "stories_review"));
        break;
      case "set-contract": {
        const contract = command.contract as { id?: string; status?: string } | undefined;
        if (contract?.status === "agreed" && contract.id) keys.add(subjectKey("contract", contract.id));
        break;
      }
      case "waive-coverage":
        newWaivers = true;
        break;
      case "set-mode":
        if (command.mode === "classic") keys.add(subjectKey("mode", "mode"));
        break;
      case "open":
        if (command.mode === "classic") keys.add(subjectKey("mode", "mode"));
        break;
      default:
        break;
    }
  }
  const existingWaivers = new Set((pre?.waivers ?? []).map((w) => subjectKey("waiver", w.id)));
  return { covers: (key) => keys.has(key) || (newWaivers && key.startsWith("waiver:") && !existingWaivers.has(key)) };
}

/** What a single human act approved in the client's dialog covers: exactly its target. */
export function humanActCoverage(action: string, command: Record<string, unknown>): ApprovalCoverage {
  const key =
    action === "confirm-story" && command.action === "confirm-story"
      ? subjectKey("story", String(command.id))
      : action === "confirm-decision" && command.action === "confirm-decision"
        ? subjectKey("decision", String(command.id))
        : action === "approve-service" && command.action === "set-service"
          ? subjectKey("service", String((command.service as { id?: string } | undefined)?.id))
          : null;
  return { covers: (candidate) => key !== null && candidate === key };
}
