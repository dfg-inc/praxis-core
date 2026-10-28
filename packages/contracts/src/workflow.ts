import { createHash, createPublicKey, verify } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { z } from "zod";
import { WorkflowError } from "./errors.js";
import { parseStrict } from "./command-strict.js";
import { evaluateEvidence, requirementCoverage, requiredRequirements, type FeatureEvaluation } from "./quality-model.js";
import { RequirementIdSchema } from "./ids.js";
import { PlanningStateFields, ScopeSchema, WorkItemKindSchema, WorkflowModeSchema } from "./planning-schemas.js";
import { PLANNING_ACTIONS, PlanningCommandSchemas, acceptanceStatus, applyPlanningCommand, migrateWorkflowState, type PlanningCommand } from "./planning.js";
import { humanActContent } from "./human-acts.js";
import { verifyUserApproval, type UserApproval } from "./user-approval.js";
import { verifyUserChannel, type ReviewChannel } from "./planning.js";
import {
  ReviewMarkSchema,
  assertStoryNarrative,
  ChangeRecordSchema,
  CoverageEntrySchema,
  type EvidenceSource,
  type CoverageEntry,
  missingRepositoryPrompts,
  rollupStoryVerdict,
  StoryCapabilitySchema,
  StoryIdSchema,
  UserStorySchema,
} from "./story.js";

/**
 * Jira-independent workflow domain.
 * Existing handoff schemas stay valid. This module adds stable local identity,
 * bidirectional handoffs, traceability, and capability routing.
 */

export const WORKFLOW_CONTRACT_VERSION = "1.1.0";
/** Contract versions a saved state may carry. 1.0.0 states load unchanged (every 1.1.0 field has a default) and are migrated on read. */
export const SUPPORTED_WORKFLOW_VERSIONS = ["1.0.0", "1.1.0"] as const;

export const WorkflowStageSchema = z.enum([
  "draft",
  "clarification_required",
  "ready",
  "in_progress",
  "review_required",
  "changes_requested",
  "blocked",
  "approved",
  "completed",
]);
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export const WorkflowRoleSchema = z.enum([
  "user",
  "ba",
  "architect",
  "developer",
  "quality",
]);
export type WorkflowRole = z.infer<typeof WorkflowRoleSchema>;

export const ClarificationClassSchema = z.enum([
  "blocking",
  "non_blocking",
  "recommendation",
  "informational",
]);
export type ClarificationClass = z.infer<typeof ClarificationClassSchema>;

export const SideEffectSchema = z.enum([
  "read",
  "local_write",
  "external_mutate",
  "destructive",
]);
export type SideEffect = z.infer<typeof SideEffectSchema>;

export const QualityVerdictSchema = z.enum([
  "PASS",
  "PASS_WITH_RISKS",
  "FAIL",
]);
export type QualityVerdict = z.infer<typeof QualityVerdictSchema>;

/** Stable requirement id. Accepts legacy canon ids and source-independent REQ ids. */
export { RequirementIdSchema };

export const WorkItemSourceSchema = z.enum([
  "local",
  "markdown",
  "repository",
  "jira",
]);

export const WorkTrackingProviderSchema = z.enum(["local", "jira"]);
export type WorkTrackingProvider = z.infer<typeof WorkTrackingProviderSchema>;

const TRANSITIONS: Record<WorkflowStage, readonly WorkflowStage[]> = {
  draft: ["clarification_required", "ready", "blocked"],
  clarification_required: ["draft", "ready", "blocked"],
  ready: ["in_progress", "clarification_required", "blocked"],
  in_progress: ["review_required", "changes_requested", "blocked", "clarification_required"],
  review_required: ["approved", "changes_requested", "blocked", "in_progress"],
  changes_requested: ["in_progress", "clarification_required", "blocked"],
  blocked: ["draft", "clarification_required", "ready", "in_progress"],
  approved: ["completed", "changes_requested", "in_progress"],
  completed: ["changes_requested"],
};

export { WorkflowError };

export const WorkItemRelationSchema = z.enum(["depends-on", "blocks", "relates-to", "derived-from"]);

/** Reference to a work item that lives in another repository (or this one). */
export const WorkItemLinkSchema = z.object({
  repository: z.string().min(1),
  workItemId: z.string().min(1),
  relation: WorkItemRelationSchema,
});
export type WorkItemLink = z.infer<typeof WorkItemLinkSchema>;

export const WorkItemSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  source: WorkItemSourceSchema,
  /** Optional external key. Never the work item's identity. */
  jiraIssueKey: z.string().min(1).optional(),
  /** Tracker that owns the external record. Local work leaves this unset. */
  provider: WorkTrackingProviderSchema.optional(),
  /** External record id (Jira id). Not the Praxis id. */
  externalId: z.string().min(1).optional(),
  /** Human-facing external number (PROJ-1, STR0001234). */
  externalNumber: z.string().min(1).optional(),
  /** Instance base URL or tenant id. Distinguishes two trackers of the same kind. */
  instanceId: z.string().min(1).optional(),
  status: WorkflowStageSchema,
  revision: z.number().int().nonnegative(),
  links: z.array(WorkItemLinkSchema).optional(),
  /** A new feature, a change to existing behaviour, an extension, a fix or a technical change across services. */
  kind: WorkItemKindSchema.default("feature"),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  requirementId: RequirementIdSchema,
  statement: z.string().min(1),
  revision: z.number().int().positive(),
  /** The user's decision about this one criterion. */
  review: ReviewMarkSchema.default({ status: "pending" }),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const RequirementSchema = z.object({
  id: RequirementIdSchema,
  statement: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.enum(["proposed", "approved", "superseded"]),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema),
  serviceIds: z.array(z.string()),
  assumptionIds: z.array(z.string()),
  /** "in" is the current scope; "deferred" and "excluded" take the requirement out of what stories and development must cover. */
  scope: ScopeSchema.default("in"),
  scopeNote: z.string().optional(),
  repositoryIds: z.array(z.string()).default([]),
  comment: z.string().optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const ServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum([
    "application",
    "module",
    "api",
    "worker",
    "frontend",
    "persistence",
    "external",
  ]),
  repository: z.string().optional(),
  /** The registered repository this service lives in. */
  repositoryId: z.string().optional(),
  localPath: z.string().optional(),
  remoteUrl: z.string().optional(),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  changeRequest: z.string().optional(),
  responsibilities: z.array(z.string()),
  requirementIds: z.array(RequirementIdSchema),
  dependsOn: z.array(z.string()),
  status: WorkflowStageSchema,
});
export type Service = z.infer<typeof ServiceSchema>;

export const ArtifactRefSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  revision: z.number().int().positive(),
  role: WorkflowRoleSchema,
});

export const RoleHandoffSchema = z.object({
  contract: z.literal("praxis.role.handoff"),
  version: z.enum(SUPPORTED_WORKFLOW_VERSIONS),
  workflowId: z.string().min(1),
  workItemId: z.string().min(1),
  handoffId: z.string().min(1),
  sourceRole: WorkflowRoleSchema,
  targetRole: WorkflowRoleSchema,
  serviceIds: z.array(z.string()),
  requirementIds: z.array(RequirementIdSchema),
  acceptanceCriterionIds: z.array(z.string()),
  storyIds: z.array(z.string()).default([]),
  artifactRefs: z.array(ArtifactRefSchema),
  decisions: z.array(z.string()),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  blockers: z.array(z.string()),
  decisionRecords: z
    .array(
      z.object({
        id: z.string(),
        statement: z.string(),
        confirmed: z.boolean(),
        revision: z.number().int().positive(),
        rationale: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .default([]),
  notes: z.string().optional(),
  /** Carried-forward items this handoff declares resolved (exact text). Audit only. */
  resolved: z.array(z.string()).default([]),
  nextActions: z.array(z.string()),
  readiness: z.enum(["ready", "partial", "blocked"]),
  evidenceRefs: z.array(z.string()),
  revision: z.number().int().positive(),
  supersedes: z.string().optional(),
  fingerprint: z.string().min(1),
});
export type RoleHandoff = z.infer<typeof RoleHandoffSchema>;

export const FindingSchema = z.object({
  id: z.string().min(1),
  requirementIds: z.array(RequirementIdSchema).min(1),
  serviceIds: z.array(z.string()),
  owner: WorkflowRoleSchema,
  summary: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  status: z.enum(["open", "resolved"]),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  storyIds: z.array(z.string()).optional(),
  acceptanceCriterionIds: z.array(z.string()).optional(),
  repository: z.string().optional(),
  file: z.string().optional(),
  expected: z.string().optional(),
  observed: z.string().optional(),
  reproduction: z.array(z.string()).optional(),
  suggestion: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const VerdictRecordSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(["requirement", "service", "feature"]),
  scopeId: z.string().min(1),
  verdict: QualityVerdictSchema,
  evidenceRefs: z.array(z.string()),
  requirementIds: z.array(RequirementIdSchema),
  stale: z.boolean(),
  invalidatedBy: z.string().optional(),
});
export type VerdictRecord = z.infer<typeof VerdictRecordSchema>;

export const CapabilitySchema = z.object({
  id: z.string().min(1),
  plugin: z.string().min(1),
  description: z.string().min(1),
  intents: z.array(z.string()),
  stages: z.array(WorkflowStageSchema),
  roles: z.array(WorkflowRoleSchema),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  dependencies: z.array(z.string()),
  sideEffect: SideEffectSchema,
  activation: z.enum(["guidance", "suggested", "explicit"]),
  version: z.string().min(1),
  installed: z.boolean(),
});
export type Capability = z.infer<typeof CapabilitySchema>;

export const WorkflowStateSchema = z.object({
  contract: z.literal("praxis.workflow.state"),
  version: z.enum(SUPPORTED_WORKFLOW_VERSIONS),
  workflowId: z.string().min(1),
  projectId: z.string().min(1),
  workItem: WorkItemSchema,
  requirements: z.array(RequirementSchema),
  services: z.array(ServiceSchema),
  handoffs: z.array(RoleHandoffSchema),
  findings: z.array(FindingSchema),
  verdicts: z.array(VerdictRecordSchema),
  decisions: z.array(
    z.object({
      id: z.string(),
      statement: z.string(),
      confirmed: z.boolean(),
      revision: z.number().int().positive(),
      rationale: z.string().optional(),
      notes: z.string().optional(),
    }),
  ),
  openQuestions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  notes: z.string().optional(),
  assumptions: z.array(
    z.object({
      id: z.string(),
      statement: z.string(),
      requirementIds: z.array(RequirementIdSchema),
    }),
  ),
  implementationUnits: z
    .array(
      z.object({
        id: z.string().min(1),
        serviceId: z.string().min(1),
        requirementIds: z.array(RequirementIdSchema),
        path: z.string().min(1),
        summary: z.string().min(1),
        contractRef: z.string().optional(),
        stale: z.boolean(),
      }),
    )
    .default([]),
  stories: z.array(UserStorySchema).default([]),
  coverage: z.array(CoverageEntrySchema).default([]),
  /** Bumped on every change to coverage: lets a writer say which coverage it saw (EVIDENCE_STALE). */
  coverageRevision: z.number().int().nonnegative().default(0),
  changes: z.array(ChangeRecordSchema).default([]),
  stage: WorkflowStageSchema,
  history: z.array(
    z.object({
      revision: z.number().int().positive(),
      stage: WorkflowStageSchema,
      note: z.string(),
    }),
  ),
  ...PlanningStateFields,
});
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

const SECRET_KEY =
  /token|secret|password|authorization|api[_-]?key|private[_-]?key/i;

/** What the store writes. The prototype is kept as written: mock rows and API examples legitimately contain names like password or Authorization (real secrets are refused when the prototype is set). */
export function redactState<T extends { prototype?: unknown }>(state: T): T {
  const { prototype, ...rest } = state;
  return { ...redactPersistent(rest), ...(prototype === undefined ? {} : { prototype }) } as T;
}

export function redactPersistent<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactPersistent(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactPersistent(child);
    }
    return out as T;
  }
  if (
    typeof value === "string" &&
    /^(Bearer\s+)?[A-Za-z0-9_\-]{40,}$/.test(value) &&
    !/^[0-9a-f]{40}$/i.test(value) &&
    !/^[0-9a-f]{64}$/i.test(value)
  ) {
    return "[redacted]" as T;
  }
  return value;
}

export function assertTransition(from: WorkflowStage, to: WorkflowStage): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `cannot transition ${from} → ${to}`,
    );
  }
}

export function transition(
  state: WorkflowState,
  to: WorkflowStage,
  note: string,
): WorkflowState {
  assertTransition(state.stage, to);
  if (state.stage === to) return state;
  const revision = state.workItem.revision + 1;
  return {
    ...state,
    stage: to,
    workItem: { ...state.workItem, status: to, revision },
    history: [...state.history, { revision, stage: to, note }],
  };
}

const TRANSLIT: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g" };
/** Latin ids for any title: Cyrillic is transliterated so a Russian title gets a descriptive stable id instead of WORK. */
function latin(title: string): string {
  return [...title.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join("");
}

export function workItemIdFor(title: string, sequence = 1): string {
  const slug = latin(title)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return `WI-${slug || "WORK"}-${String(sequence).padStart(3, "0")}`;
}

export function openLocalWorkflow(input: {
  projectId: string;
  title: string;
  source?: WorkItem["source"];
  jiraIssueKey?: string;
  request: string;
  /** Sequence within the title slug. The store picks the next free one when ids collide. */
  sequence?: number;
  mode?: z.infer<typeof WorkflowModeSchema>;
  changeKind?: z.infer<typeof WorkItemKindSchema>;
}): WorkflowState {
  const workItemId = workItemIdFor(input.title, input.sequence ?? 1);
  const workflowId = `WF-${workItemId}`;
  return WorkflowStateSchema.parse({
    contract: "praxis.workflow.state",
    version: WORKFLOW_CONTRACT_VERSION,
    workflowId,
    projectId: input.projectId,
    workItem: {
      id: workItemId,
      projectId: input.projectId,
      title: input.title,
      source: input.source ?? "local",
      ...(input.jiraIssueKey ? { jiraIssueKey: input.jiraIssueKey } : {}),
      status: "draft",
      revision: 1,
      kind: input.changeKind ?? "feature",
    },
    mode: input.mode ?? "guided",
    phase: "request",
    // Opening in classic mode is visible in the record the next chat and the user read first.
    ...(input.mode === "classic" ? { sessionLog: [{ at: new Date().toISOString(), summary: "opened in classic mode: stage gates, plan-before-stories and coverage checks are not enforced (user decisions still are)" }] } : {}),
    requirements: [],
    services: [],
    handoffs: [],
    findings: [],
    verdicts: [],
    decisions: [],
    assumptions: [],
    stage: "draft",
    history: [
      {
        revision: 1,
        stage: "draft",
        note: input.request.slice(0, 500),
      },
    ],
  });
}

export function addRequirement(
  state: WorkflowState,
  input: {
    id: string;
    statement: string;
    acceptanceCriteria: string[];
    serviceIds?: string[];
  },
): WorkflowState {
  const id = RequirementIdSchema.parse(input.id);
  if (state.requirements.some((r) => r.id === id && r.status !== "superseded")) {
    throw new WorkflowError("DUPLICATE_REQUIREMENT", `requirement ${id} already exists`);
  }
  const requirement: Requirement = {
    id,
    statement: input.statement,
    revision: 1,
    status: "proposed",
    serviceIds: input.serviceIds ?? [],
    assumptionIds: [],
    acceptanceCriteria: input.acceptanceCriteria.map((statement, index) => ({
      id: `${id}-AC-${String(index + 1).padStart(2, "0")}`,
      requirementId: id,
      statement,
      revision: 1,
      review: { status: "pending" as const },
    })),
    scope: "in",
    repositoryIds: [],
  };
  return { ...state, requirements: [...state.requirements, requirement] };
}

export function reviseRequirement(
  state: WorkflowState,
  id: string,
  statement: string,
): WorkflowState {
  const current = state.requirements.find((r) => r.id === id && r.status !== "superseded");
  if (!current) throw new WorkflowError("MISSING_REQUIREMENT", `requirement ${id} not found`);
  const revised: Requirement = {
    ...current,
    statement,
    revision: current.revision + 1,
    status: "proposed",
  };
  const verdicts = state.verdicts.map((v) =>
    v.requirementIds.includes(id as Requirement["id"])
      ? { ...v, stale: true, invalidatedBy: id }
      : v,
  );
  const implementationUnits = state.implementationUnits.map((unit) =>
    unit.requirementIds.includes(id as Requirement["id"])
      ? { ...unit, stale: true }
      : unit,
  );
  const stories = state.stories.map((story) =>
    story.requirementIds.includes(id as Requirement["id"])
      ? { ...story, stale: true, revision: story.revision + 1 }
      : story,
  );
  return {
    ...state,
    requirements: state.requirements.map((r) => (r.id === id ? revised : r)),
    verdicts,
    implementationUnits,
    stories,
    history: [
      ...state.history,
      {
        revision: state.workItem.revision + 1,
        stage: state.stage,
        note: `requirement ${id} revised to r${revised.revision}; downstream verdicts stale`,
      },
    ],
    workItem: { ...state.workItem, revision: state.workItem.revision + 1 },
  };
}

function fingerprintPayload(payload: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = canonicalValue(source[key]);
    }
    return out;
  }
  return value;
}

export type HumanActRequest = {
  action: "confirm-story" | "confirm-decision" | "approve-service" | "revise-acceptance";
  targetId: string;
  /** Exactly what the approval must bind. */
  content: string;
  /** Stable id: the same subject always proposes the same plan, so a standing approval is found, not duplicated. */
  planId: string;
  role: "ba" | "architect" | "quality";
  summary: string;
  /** Everything the human needs to decide, in plain text. */
  description: string;
  risks: string[];
};

const bullet = (items: readonly string[]) => (items.length ? items.map((item) => `  - ${item}`).join("\n") : "  (none)");

/**
 * If this command is a human act, what must be asked of the human. Built only from the Runtime's own state, so
 * what the human is shown is what the approval will bind.
 */
export function humanActRequest(state: WorkflowState, command: WorkflowCommand): HumanActRequest | null {
  const idFor = (action: string, content: string) =>
    `hg-${action}-${createHash("sha256").update(content).digest("hex").slice(0, 20)}`;
  if (command.action === "confirm-story") {
    const story = state.stories.find((item) => item.id === command.id && item.status !== "superseded");
    if (!story) return null;
    const contentFingerprint = storyContentFingerprint(story);
    const content = humanActContent("confirm-story", { storyId: story.id, revision: story.revision, contentFingerprint });
    return {
      action: "confirm-story",
      targetId: story.id,
      content,
      planId: idFor("confirm-story", content),
      role: "ba",
      summary: `Confirm Story ${story.id} revision ${story.revision}`,
      description: [
        `Story ${story.id} (revision ${story.revision}) for requirement(s) ${story.requirementIds.join(", ")}.`,
        `As ${story.actor}: ${story.narrative}`,
        `Objective: ${story.objective}`,
        `User value: ${story.userValue}`,
        `Preconditions:\n${bullet(story.preconditions)}`,
        `Happy path:\n${bullet(story.happyPath)}`,
        `Alternatives:\n${bullet(story.alternatives)}`,
        `Negative cases:\n${bullet(story.negative)}`,
        `Edge cases:\n${bullet(story.edgeCases)}`,
        `Business rules:\n${bullet(story.businessRules)}`,
        `Acceptance criteria:\n${bullet(story.acceptanceCriteria.map((c) => `${c.id}: Given ${c.given}; When ${c.when}; Then ${c.then}`))}`,
        `Expected results:\n${bullet(story.expectedResults)}`,
        `Content fingerprint: ${contentFingerprint}`,
      ].join("\n"),
      risks: ["Confirming records that you accept this behavior as written. It does not authorize implementation, commits or pushes."],
    };
  }
  if (command.action === "confirm-decision") {
    const decision = state.decisions.find((item) => item.id === command.id);
    if (!decision) return null;
    const contentFingerprint = decisionContentFingerprint(decision);
    const content = humanActContent("confirm-decision", { decisionId: decision.id, revision: decision.revision, contentFingerprint });
    return {
      action: "confirm-decision",
      targetId: decision.id,
      content,
      planId: idFor("confirm-decision", content),
      role: "architect",
      summary: `Confirm architecture decision ${decision.id}`,
      description: [
        `Decision ${decision.id} (revision ${decision.revision}).`,
        decision.statement,
        decision.rationale ? `Rationale: ${decision.rationale}` : "Rationale: (none recorded)",
        decision.notes ? `Notes: ${decision.notes}` : "",
        `Content fingerprint: ${contentFingerprint}`,
      ].filter(Boolean).join("\n"),
      risks: ["Confirming records the decision as accepted. It does not confirm stories, authorize implementation or approve any service."],
    };
  }
  if (command.action === "revise-acceptance") {
    // The user approves the exact rewording. A repeat of the stored text asks for nothing; an unknown id is the reducer's error to report.
    const rows: Array<{ id: string; requirementId: string; revision: number; status: string; comment?: string; from: string; to: string }> = [];
    for (const edit of command.edits) {
      const owner = state.requirements.find((r) => r.status !== "superseded" && r.acceptanceCriteria.some((c) => c.id === edit.id));
      const criterion = owner?.acceptanceCriteria.find((c) => c.id === edit.id);
      if (!owner || !criterion) return null;
      if (criterion.statement.trim() !== edit.statement.trim()) rows.push({ id: criterion.id, requirementId: owner.id, revision: criterion.revision, status: criterion.review.status, ...(criterion.review.comment ? { comment: criterion.review.comment } : {}), from: criterion.statement, to: edit.statement.trim() });
    }
    if (rows.length === 0) return null;
    const content = humanActContent("revise-acceptance", { workItemId: state.workItem.id, edits: rows });
    const accepted = rows.filter((row) => row.status === "accepted");
    return {
      action: "revise-acceptance",
      targetId: rows.map((row) => row.id).join(","),
      content,
      planId: idFor("revise-acceptance", content),
      role: "ba",
      summary: `Reword ${rows.length} acceptance criterion(a): ${rows.map((row) => row.id).join(", ")}`,
      description: [
        ...rows.map((row) => [`${row.id} (revision ${row.revision} -> ${row.revision + 1}, now ${row.status.toUpperCase()}${row.comment ? `, your remark: "${row.comment}"` : ""}):`, `  from: ${row.from}`, `  to:   ${row.to}`].join("\n")),
        accepted.length ? `WARNING: ${accepted.map((row) => row.id).join(", ")} ${accepted.length === 1 ? "is" : "are"} ACCEPTED by you. Approving withdraws that acceptance: the criterion returns to pending and you decide again.` : "",
        "Each reworded criterion returns to pending; its earlier decision and remark stay readable as 'previous'. No other criterion changes.",
      ].filter(Boolean).join("\n"),
      risks: ["Rewording a criterion changes what you reviewed: it returns to pending and the requirement's stories, verdicts and implementation records become stale."],
    };
  }
  if (command.action === "set-service") {
    const approving = command.service.status === "approved" || command.service.status === "completed";
    const previous = state.services.find((item) => item.id === command.service.id);
    if (!approving || (previous && fingerprintPayload(previous) === fingerprintPayload(command.service))) return null;
    const subject = serviceApprovalSubject(state, command.service);
    const content = humanActContent("approve-service", subject);
    const verdicts = state.verdicts.filter((v) => !v.stale && v.scope === "service" && v.scopeId === command.service.id);
    return {
      action: "approve-service",
      targetId: command.service.id,
      content,
      planId: idFor("approve-service", content),
      role: "quality",
      summary: `Mark service ${command.service.id} ${command.service.status}`,
      description: [
        `Service ${command.service.id} (${command.service.name}) in work item ${state.workItem.id}: ${previous?.status ?? "new"} -> ${command.service.status}.`,
        `Responsibilities:\n${bullet(command.service.responsibilities)}`,
        `Requirements: ${command.service.requirementIds.join(", ") || "(none)"}`,
        `Depends on: ${command.service.dependsOn.join(", ") || "(none)"}`,
        `Implementation it rests on:\n${bullet((subject.implementation as Array<{ id: string; path: string; summary: string }>).map((u) => `${u.id} ${u.path}: ${u.summary}`))}`,
        `Quality verdicts on record:\n${bullet(verdicts.map((v) => `${v.id}: ${v.verdict}`))}`,
      ].join("\n"),
      risks: ["Approving a service is part of declaring the feature complete. It does not confirm stories or decisions, commit or push anything."],
    };
  }
  return null;
}

export function decisionContentFingerprint(decision: {
  id: string;
  statement: string;
  rationale?: string;
  notes?: string;
  revision: number;
}): string {
  return fingerprintPayload({
    id: decision.id,
    revision: decision.revision,
    statement: decision.statement,
    rationale: decision.rationale ?? null,
    notes: decision.notes ?? null,
  });
}

/** What approving a service binds: the service as recorded and the implementation it rests on. */
export function serviceApprovalSubject(
  state: Pick<WorkflowState, "workItem" | "implementationUnits">,
  service: Service,
): Record<string, unknown> {
  const { status: _status, ...rest } = service;
  return {
    workItemId: state.workItem.id,
    serviceId: service.id,
    status: service.status,
    serviceDigest: fingerprintPayload(rest),
    implementation: state.implementationUnits
      .filter((unit) => unit.serviceId === service.id && !unit.stale)
      .map((unit) => ({ id: unit.id, path: unit.path, summary: unit.summary }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function storyContentFingerprint(story: {
  id: string;
  revision: number;
  narrative: string;
  objective: string;
  acceptanceCriteria: unknown;
  expectedResults: unknown;
  assumptionIds: unknown;
}): string {
  return fingerprintPayload({
    id: story.id,
    revision: story.revision,
    narrative: story.narrative,
    objective: story.objective,
    acceptanceCriteria: story.acceptanceCriteria,
    expectedResults: story.expectedResults,
    assumptionIds: story.assumptionIds,
  });
}

export function exportWorkflowSnapshot(state: WorkflowState) {
  return {
    contract: "praxis.workflow.snapshot" as const,
    version: WORKFLOW_CONTRACT_VERSION,
    workflowId: state.workflowId,
    decisions: state.decisions.map((decision) => ({ ...decision })),
    openQuestions: [...state.openQuestions],
    risks: [...state.risks],
    blockers: [...state.blockers],
    notes: state.notes,
    stories: state.stories.map((story) => ({
      id: story.id,
      revision: story.revision,
      confirmedBehavior: story.confirmedBehavior,
      status: story.status,
    })),
  };
}

export function renderWorkflowSnapshotHtml(state: WorkflowState): string {
  const snapshot = exportWorkflowSnapshot(state);
  const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const decisions = snapshot.decisions
    .map(
      (decision) =>
        `<li>${esc(decision.id)}: ${esc(decision.statement)} rationale=${esc(decision.rationale ?? "")} notes=${esc(decision.notes ?? "")}</li>`,
    )
    .join("");
  const questions = snapshot.openQuestions.map((item) => `<li>${esc(item)}</li>`).join("");
  return `<section><h1>Decisions</h1><ul>${decisions}</ul><h1>Open questions</h1><ul>${questions}</ul><p>${esc(snapshot.notes ?? "")}</p></section>`;
}

export function createHandoff(
  state: WorkflowState,
  input: Omit<
    RoleHandoff,
    | "contract"
    | "version"
    | "workflowId"
    | "workItemId"
    | "handoffId"
    | "revision"
    | "fingerprint"
    | "supersedes"
    | "storyIds"
    | "decisionRecords"
    | "notes"
    | "resolved"
  > & {
    supersedes?: string;
    storyIds?: string[];
    decisionRecords?: RoleHandoff["decisionRecords"];
    notes?: string;
    resolved?: string[];
  },
): { state: WorkflowState; handoff: RoleHandoff; duplicate: boolean } {
  const body = {
    workflowId: state.workflowId,
    workItemId: state.workItem.id,
    sourceRole: input.sourceRole,
    targetRole: input.targetRole,
    serviceIds: input.serviceIds,
    requirementIds: input.requirementIds,
    acceptanceCriterionIds: input.acceptanceCriterionIds,
    storyIds: input.storyIds ?? [],
    artifactRefs: input.artifactRefs,
    decisions: input.decisions,
    decisionRecords: input.decisionRecords ?? [],
    assumptions: input.assumptions,
    openQuestions: input.openQuestions,
    risks: input.risks,
    blockers: input.blockers,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    // Only hashed when present so handoffs persisted before `resolved` keep their fingerprints.
    ...(input.resolved && input.resolved.length > 0 ? { resolved: input.resolved } : {}),
    nextActions: input.nextActions,
    readiness: input.readiness,
    evidenceRefs: input.evidenceRefs,
  };
  const fingerprint = fingerprintPayload(body);
  const existing = state.handoffs.find((h) => h.fingerprint === fingerprint);
  if (existing) return { state, handoff: existing, duplicate: true };
  const handoff = RoleHandoffSchema.parse({
    contract: "praxis.role.handoff",
    version: WORKFLOW_CONTRACT_VERSION,
    ...body,
    handoffId: `HO-${state.handoffs.length + 1}`,
    revision: state.handoffs.length + 1,
    fingerprint,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  });
  const nextStage: WorkflowStage =
    input.readiness === "blocked" ? "blocked" : "in_progress";
  const transitioned =
    state.stage === "draft" || state.stage === "ready" || state.stage === "clarification_required"
      ? transition(
          { ...state, stage: state.stage === "draft" ? "ready" : state.stage },
          nextStage === "blocked" ? "blocked" : "in_progress",
          `${input.sourceRole} → ${input.targetRole}`,
        )
      : state;
  return {
    state: { ...transitioned, handoffs: [...transitioned.handoffs, handoff] },
    handoff,
    duplicate: false,
  };
}

export function resumeWorkflow(state: WorkflowState): {
  state: WorkflowState;
  nextRole: WorkflowRole;
  requirementIds: string[];
  duplicateHandoff: false;
} {
  const last = state.handoffs[state.handoffs.length - 1];
  return {
    state,
    nextRole: last?.targetRole ?? "ba",
    requirementIds: state.requirements.filter((r) => r.status !== "superseded").map((r) => r.id),
    duplicateHandoff: false,
  };
}

export function featureReadiness(state: WorkflowState): {
  ready: boolean;
  serviceStatus: Record<string, WorkflowStage>;
  /** Services that depend on something not done, or on something that is not a service of this work item. */
  missingIntegration: string[];
  /** Dependencies named by a service that no service of this work item provides. */
  unknownDependencies: string[];
} {
  const serviceStatus: Record<string, WorkflowStage> = {};
  for (const service of state.services) serviceStatus[service.id] = service.status;
  const done = (status: WorkflowStage) => status === "approved" || status === "completed";
  const unknownDependencies = [
    ...new Set(
      state.services.flatMap((service) => service.dependsOn.filter((dep) => !state.services.some((item) => item.id === dep))),
    ),
  ];
  const missingIntegration = state.services
    .filter((service) =>
      service.dependsOn.some((dep) => {
        const upstream = state.services.find((item) => item.id === dep);
        return !upstream || !done(upstream.status);
      }),
    )
    .map((service) => service.id);
  // Ready means every service is done AND nothing is waiting on an integration. The two answers cannot disagree:
  // a service that depends on a dependency nobody provides is not ready, even if every listed service is done.
  const ready =
    state.services.length > 0 && state.services.every((service) => done(service.status)) && missingIntegration.length === 0;
  return { ready, serviceStatus, missingIntegration, unknownDependencies };
}

const PARTIAL_SUCCESS =
  /invalid[^.]*must not (?:prevent|block)[^.]*valid|never prevent valid rows|not all-or-nothing|each row has its own outcome/i;

/** Classify import code. A caller-supplied label is not evidence. */
export function inspectImportImplementation(
  source: string,
): "partial-success" | "all-or-nothing" | "unspecified" {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const continues =
    /if\s*\([^)]*invalid[^)]*\)[\s\S]{0,120}?\bcontinue\b/i.test(code) ||
    /invalid rows are recorded[\s\S]{0,160}?\bcontinue\b/i.test(code);
  const wrapsAllRows =
    /\.transaction\s*\(\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{[\s\S]*\bfor\s*\([\s\S]*\bthrow\b/i.test(
      code,
    );
  if (wrapsAllRows && !continues) return "all-or-nothing";
  if (continues && !wrapsAllRows) return "partial-success";
  if (wrapsAllRows) return "all-or-nothing";
  return "unspecified";
}

export function evaluateRequirementBehavior(input: {
  requirementId: string;
  statement: string;
  observedBehavior: "partial-success" | "all-or-nothing" | "unspecified";
  testsGreen?: boolean;
  developerClaimsPass?: boolean;
}): {
  verdict: QualityVerdict;
  finding?: Finding;
} {
  const id = RequirementIdSchema.parse(input.requirementId);
  const requiresPartial = PARTIAL_SUCCESS.test(input.statement);
  if (requiresPartial && input.observedBehavior === "all-or-nothing") {
    return {
      verdict: "FAIL",
      finding: {
        id: `F-${id}`,
        requirementIds: [id],
        serviceIds: [],
        owner: "developer",
        summary: `${id} requires partial success. Observed all-or-nothing transaction behavior, so invalid rows block valid users.`,
        evidence: [
          `requirement:${id}`,
          `observed:${input.observedBehavior}`,
          `testsGreen:${Boolean(input.testsGreen)}`,
          "developer claim is not independent evidence",
        ],
        status: "open",
      },
    };
  }
  if (input.observedBehavior === "unspecified") {
    return {
      verdict: "PASS_WITH_RISKS",
      finding: {
        id: `F-${id}-evidence`,
        requirementIds: [id],
        serviceIds: [],
        owner: "developer",
        summary: `${id} has no independent behavioral evidence. Green tests alone are insufficient.`,
        evidence: [`requirement:${id}`, "missing independent evidence"],
        status: "open",
      },
    };
  }
  return { verdict: "PASS" };
}

/**
 * Context a role hands on must not vanish at the next hop. The new handoff starts from the
 * latest handoff addressed to its source role, minus items it explicitly resolves, plus its own.
 */
function carryForwardContext(
  state: WorkflowState,
  command: Extract<WorkflowCommand, { action: "handoff" }>,
): { assumptions: string[]; openQuestions: string[]; risks: string[]; blockers: string[]; notes?: string } {
  const incoming = [...state.handoffs].reverse().find((h) => h.targetRole === command.sourceRole);
  const resolved = new Set(command.resolved);
  const merge = (carriedItems: string[], own: string[]) => [
    ...new Set([...carriedItems.filter((item) => !resolved.has(item)), ...own]),
  ];
  const own = {
    openQuestions: command.openQuestions.length > 0 ? command.openQuestions : state.openQuestions,
    risks: command.risks ?? state.risks,
    blockers: command.blockers.length > 0 ? command.blockers : state.blockers,
  };
  const notes = command.notes ?? incoming?.notes ?? state.notes;
  return {
    assumptions: merge(incoming?.assumptions ?? [], command.assumptions),
    openQuestions: merge(incoming?.openQuestions ?? [], own.openQuestions),
    risks: merge(incoming?.risks ?? [], own.risks),
    blockers: merge(incoming?.blockers ?? [], own.blockers),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export type RequirementEvidence =
  | { status: "missing"; reasons: string[] }
  | { status: "executed"; verdict: QualityVerdict; reasons: string[]; provenance: string[]; counts: import("./quality-model.js").CoverageCounts };

/**
 * The single source of a requirement's executed evidence: every current acceptance criterion needs a current, independently
 * executed PASS (see quality-model.ts). Used by record-verification, quality-check, verify-stories and feature-verdict, so their
 * requirement verdicts cannot diverge.
 */
export function requirementEvidence(state: WorkflowState, requirementId: string): RequirementEvidence {
  const cov = requirementCoverage(state, requirementId);
  if (cov.noEvidence) return { status: "missing", reasons: ["missing independent evidence", ...cov.reasons.filter((r) => r.includes("older revision"))] };
  const scenarios = state.coverage.filter((e) => e.requirementId === requirementId && cov.criteria.some((c) => c.scenarios.includes(e.scenarioId)));
  const stories = [...new Set(scenarios.flatMap((e) => (e.storyId ? [e.storyId] : [])))];
  const provenance = [
    ...stories.map((id) => `story:${id}@${state.stories.find((st) => st.id === id)?.revision ?? 1}`),
    ...(stories.length === 0 ? [`requirement:${requirementId}@${state.requirements.find((r) => r.id === requirementId)?.revision ?? 1}`] : []),
    ...scenarios.map((e) => `${e.scenarioId}:${e.status}`),
    ...[...new Set(scenarios.map((e) => e.source?.kind ?? "legacy"))].map((k) => `source:${k}`),
  ];
  const c = cov.counts;
  const reasons = [`criteria: ${c.passed} of ${c.total} passed, ${c.failed} failed, ${c.blocked} blocked, ${c.missing} missing, ${c.stale} stale, ${c.attested} attested`, ...cov.reasons];
  return { status: "executed", verdict: cov.verdict, reasons, provenance, counts: c };
}

export function recordVerdict(
  state: WorkflowState,
  verdict: Omit<VerdictRecord, "stale">,
): WorkflowState {
  return {
    ...state,
    verdicts: [...state.verdicts, { ...verdict, stale: false }],
    findings: verdict.verdict === "FAIL" ? state.findings : state.findings,
  };
}

export function returnFinding(
  state: WorkflowState,
  finding: Finding,
): { state: WorkflowState; handoff: RoleHandoff } {
  const withFinding: WorkflowState = {
    ...transition(
      state.stage === "review_required" || state.stage === "approved" || state.stage === "completed"
        ? state
        : { ...state, stage: "review_required" },
      "changes_requested",
      `finding ${finding.id} returned to ${finding.owner}`,
    ),
    findings: [...state.findings.filter((f) => f.id !== finding.id), finding],
  };
  const created = createHandoff(withFinding, {
    sourceRole: "quality",
    targetRole: finding.owner === "quality" ? "developer" : finding.owner,
    serviceIds: finding.serviceIds,
    requirementIds: finding.requirementIds,
    acceptanceCriterionIds: [],
    artifactRefs: [],
    decisions: [],
    assumptions: [],
    openQuestions: [],
    risks: [],
    blockers: [finding.summary],
    nextActions: [`Correct ${finding.requirementIds.join(", ")} and resubmit evidence`],
    readiness: "blocked",
    evidenceRefs: finding.evidence,
  });
  return { state: created.state, handoff: created.handoff };
}

export function classifyClarification(input: {
  alreadyKnown?: boolean;
  contradictsApproved?: boolean;
  safeAssumption?: boolean;
  changesBehavior?: boolean;
}): { klass: ClarificationClass; ask: boolean } {
  if (input.alreadyKnown) return { klass: "informational", ask: false };
  if (input.contradictsApproved || (input.changesBehavior && !input.safeAssumption)) {
    return { klass: "blocking", ask: true };
  }
  if (input.safeAssumption) return { klass: "non_blocking", ask: false };
  if (input.changesBehavior) return { klass: "recommendation", ask: false };
  return { klass: "informational", ask: false };
}

export function questionsToAsk(
  candidates: Array<{ id: string; prompt: string; alreadyKnown?: boolean; contradictsApproved?: boolean; safeAssumption?: boolean; changesBehavior?: boolean }>,
): Array<{ id: string; prompt: string; klass: ClarificationClass }> {
  return candidates
    .map((c) => ({ ...c, decision: classifyClarification(c) }))
    .filter((c) => c.decision.ask)
    .slice(0, 3)
    .map((c) => ({ id: c.id, prompt: c.prompt, klass: c.decision.klass }));
}

export function routeCapabilities(input: {
  request: string;
  role: WorkflowRole;
  stage: WorkflowStage;
  capabilities: Capability[];
}): {
  guidance: Capability[];
  suggested: Capability[];
  executed: [];
} {
  const text = input.request.toLowerCase();
  const matched = input.capabilities.filter((cap) => {
    if (!cap.installed) return false;
    if (cap.roles.length && !cap.roles.includes(input.role) && !cap.roles.includes("user")) {
      return false;
    }
    return cap.intents.some((intent) => text.includes(intent.toLowerCase()));
  });
  const guidance = matched.filter(
    (cap) => cap.sideEffect === "read" && cap.activation !== "explicit",
  );
  const suggested = matched.filter(
    (cap) => cap.sideEffect !== "read" || cap.activation === "explicit",
  );
  return { guidance, suggested, executed: [] };
}

export type JiraFailureKind =
  | "not_configured"
  | "invalid_credentials"
  | "forbidden"
  | "network"
  | "rate_limited"
  | "api_error"
  | "missing_issue"
  | "conflict"
  | "duplicate"
  | "interrupted";

export function classifyJiraFailure(kind: JiraFailureKind): {
  code: string;
  localWorkUsable: true;
  retryable: boolean;
  overwriteExternal: false;
} {
  const retryable = kind === "network" || kind === "rate_limited" || kind === "interrupted" || kind === "api_error";
  return {
    code: `JIRA_${kind.toUpperCase()}`,
    localWorkUsable: true,
    retryable,
    overwriteExternal: false,
  };
}

export function diagnoseCompatibility(input: {
  missingPlugin?: string;
  coreVersion?: string;
  expectedCore?: string;
  handoff?: unknown;
  artifactPath?: string;
  artifactExists?: boolean;
  command?: string;
}): { ok: true } | { ok: false; code: string; message: string } {
  if (input.missingPlugin) {
    return {
      ok: false,
      code: "PLUGIN_MISSING",
      message: `installed capability required: ${input.missingPlugin}`,
    };
  }
  if (input.coreVersion && input.expectedCore && input.coreVersion !== input.expectedCore) {
    return {
      ok: false,
      code: "CORE_VERSION_MISMATCH",
      message: `core ${input.coreVersion} is not ${input.expectedCore}`,
    };
  }
  if (input.handoff !== undefined) {
    const parsed = RoleHandoffSchema.safeParse(input.handoff);
    if (!parsed.success) {
      return {
        ok: false,
        code: "HANDOFF_SCHEMA_INVALID",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      };
    }
  }
  if (input.artifactPath && input.artifactExists === false) {
    return {
      ok: false,
      code: "ARTIFACT_MISSING",
      message: `missing artifact ${input.artifactPath}`,
    };
  }
  if (input.command === "") {
    return { ok: false, code: "COMMAND_UNRESOLVED", message: "command did not resolve to a skill" };
  }
  return { ok: true };
}

export const WorkflowCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    projectId: z.string().min(1),
    title: z.string().min(1),
    request: z.string().min(1),
    source: WorkItemSourceSchema.optional(),
    jiraIssueKey: z.string().min(1).optional(),
    sequence: z.number().int().positive().optional(),
    /** guided enforces the stage gates (requirements accepted, prototype, story plan, ...); classic keeps the alpha.48 behaviour. */
    mode: WorkflowModeSchema.optional(),
    /** Create a new item although one with this title exists (the store otherwise refuses: stable ids, explicit choice). */
    newItem: z.boolean().optional(),
    /** feature, change to existing behaviour, extension, fix or technical change. */
    changeKind: WorkItemKindSchema.optional(),
  }),
  z.object({
    // Resolved by the workflow store, which owns the index of work items.
    action: z.literal("select-work-item"),
    workItemId: z.string().min(1),
  }),
  z.object({
    action: z.literal("link-work-item"),
    target: WorkItemLinkSchema,
    remove: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("add-requirement"),
    id: RequirementIdSchema,
    statement: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    serviceIds: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal("handoff"),
    sourceRole: WorkflowRoleSchema,
    targetRole: WorkflowRoleSchema,
    requirementIds: z.array(RequirementIdSchema).min(1),
    serviceIds: z.array(z.string()).default([]),
    nextActions: z.array(z.string()).default([]),
    openQuestions: z.array(z.string()).default([]),
    assumptions: z.array(z.string()).default([]),
    blockers: z.array(z.string()).default([]),
    risks: z.array(z.string()).optional(),
    notes: z.string().optional(),
    resolved: z.array(z.string()).default([]),
    readiness: z.enum(["ready", "partial", "blocked"]),
  }),
  z.object({
    action: z.literal("revise-requirement"),
    id: RequirementIdSchema,
    statement: z.string().min(1),
  }),
  z.object({
    action: z.literal("set-service"),
    service: ServiceSchema,
  }),
  z.object({
    action: z.literal("clarify"),
    role: WorkflowRoleSchema,
    known: z.array(z.string()).default([]),
    questions: z.array(
      z.object({
        id: z.string().min(1),
        prompt: z.string().min(1),
        alreadyKnown: z.boolean().optional(),
        contradictsApproved: z.boolean().optional(),
        safeAssumption: z.boolean().optional(),
        assumption: z.string().min(1).optional(),
        changesBehavior: z.boolean().optional(),
      }),
    ).default([]),
  }),
  z.object({
    action: z.literal("record-decision"),
    id: z.string().min(1),
    statement: z.string().min(1),
    /** Recording a decision never confirms it; confirmation is a human act (confirm-decision) that needs the user's approval. */
    confirmed: z.boolean().default(false),
    rationale: z.string().optional(),
    notes: z.string().optional(),
  }),
  z.object({
    action: z.literal("confirm-decision"),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    contentFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
  z.object({
    action: z.literal("record-context"),
    openQuestions: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    blockers: z.array(z.string()).optional(),
    notes: z.string().optional(),
  }),
  z.object({
    action: z.literal("confirm-story"),
    id: StoryIdSchema,
    revision: z.number().int().positive(),
    contentFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
  z.object({
    action: z.literal("record-implementation"),
    id: z.string().min(1),
    serviceId: z.string().min(1),
    requirementIds: z.array(RequirementIdSchema).min(1),
    path: z.string().min(1),
    summary: z.string().min(1),
    contractRef: z.string().optional(),
  }),
  z.object({
    action: z.literal("feature-verdict"),
  }),
  z.object({
    action: z.literal("add-story"),
    id: StoryIdSchema,
    requirementIds: z.array(RequirementIdSchema).min(1),
    actor: z.string().min(1),
    narrative: z.string().min(1),
    objective: z.string().min(1),
    userValue: z.string().min(1),
    preconditions: z.array(z.string()).default([]),
    happyPath: z.array(z.string()).min(1),
    alternatives: z.array(z.string()).default([]),
    negative: z.array(z.string()).default([]),
    edgeCases: z.array(z.string()).default([]),
    businessRules: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(
      z.object({
        id: z.string().min(1),
        given: z.string().min(1),
        when: z.string().min(1),
        then: z.string().min(1),
      }),
    ).min(1),
    expectedResults: z.array(z.string()).min(1),
    dependencies: z.array(z.string()).default([]),
    assumptionIds: z.array(z.string()).default([]),
    unresolvedDecisionIds: z.array(z.string()).default([]),
    serviceIds: z.array(z.string()).default([]),
    /** Short name shown in the plan and in reviews. */
    title: z.string().min(1).optional(),
    capabilities: z.array(StoryCapabilitySchema).default([]),
    screenRefs: z.array(z.string()).default([]),
    repositoryIds: z.array(z.string()).default([]),
    confirmedBehavior: z.boolean(),
  }),
  z.object({
    action: z.literal("locate-repositories"),
  }),
  z.object({
    action: z.literal("verify-stories"),
    independentRerun: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("prepare-fix"),
    serviceId: z.string().min(1),
    authorized: z.boolean(),
    existingBranch: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("record-verification"),
    independentRerun: z.boolean().default(false),
    testsGreen: z.boolean().optional(),
    scenarios: z.array(CoverageEntrySchema).default([]),
    findings: z.array(FindingSchema).default([]),
    /** Scenario ids to remove. Only entries from the same kind of source can be removed. */
    retire: z.array(z.string().min(1)).default([]),
    /** Remove this source's earlier entries that this run did not repeat (a complete re-run). Only the caller's own source kind. */
    replaceSource: z.enum(["executed", "browser", "agent"]).optional(),
    /** The coverageRevision the writer saw; a different current value is EVIDENCE_STALE. */
    baseCoverageRevision: z.number().int().nonnegative().optional(),
  }),
  z.object({
    action: z.literal("record-change"),
    change: ChangeRecordSchema,
  }),
  ...PlanningCommandSchemas,
  z.object({
    action: z.literal("quality-check"),
    requirementId: RequirementIdSchema,
    observedBehavior: z.enum(["partial-success", "all-or-nothing", "unspecified"]).optional(),
    implementationSource: z.string().min(1).optional(),
    serviceId: z.string().min(1).optional(),
    testsGreen: z.boolean().optional(),
    developerClaimsPass: z.boolean().optional(),
  }),
]);
export type WorkflowCommand = z.infer<typeof WorkflowCommandSchema>;

/** Parses a command and refuses keys its action does not accept (they are never silently dropped). */
export function parseWorkflowCommand(raw: unknown): WorkflowCommand {
  return parseStrict(WorkflowCommandSchema, raw);
}

export function commandFingerprint(command: WorkflowCommand): string {
  return fingerprintPayload(command);
}

/** What a command would do, computed without any approval and never written: lets a preview show the exact result before the user is asked. */
export function dryRunCommand(state: WorkflowState, raw: unknown): { duplicate: boolean; result: unknown } {
  const command = parseWorkflowCommand(raw);
  if (!PLANNING_ACTIONS.has(command.action)) throw new WorkflowError("DRY_RUN_UNSUPPORTED", `${command.action} has no dry run`);
  const out = applyPlanningCommand(state, command as PlanningCommand, { approvedRewording: true });
  return { duplicate: out.duplicate, result: out.result };
}

export function applyWorkflowCommand(
  state: WorkflowState | null,
  raw: WorkflowCommand | unknown,
  /** Set by the Runtime from the user's decision. Never part of the command: nothing an agent sends can carry it. */
  options?: { userApproval?: UserApproval; now?: Date; channel?: ReviewChannel; evidenceSource?: EvidenceSource },
): { state: WorkflowState; duplicate: boolean; result: unknown } {
  const command = parseWorkflowCommand(raw);
  if (command.action === "open") {
    if (state) return { state, duplicate: true, result: { workflowId: state.workflowId } };
    // Opening in classic mode switches the stage gates off from the start: that is the user's choice, never the agent's.
    if (command.mode === "classic" && !verifyUserChannel(command as unknown as Record<string, unknown>, options?.channel)) {
      throw new WorkflowError("USER_DECISION_REQUIRED", "opening a work item in classic mode turns the stage gates off, so the user chooses it (the Runtime asks them in the approval dialog). Open it without a mode to get the guided flow.");
    }
    const opened = openLocalWorkflow(command);
    return { state: opened, duplicate: false, result: { workflowId: opened.workflowId, workItemId: opened.workItem.id, mode: opened.mode, ...(opened.mode === "classic" ? { note: "This work item is classic: stage gates, plan-before-stories and coverage checks are not enforced (user decisions still are). Tell the user." } : {}) } };
  }
  if (command.action === "select-work-item") {
    throw new WorkflowError("EXECUTION_REQUIRED", "select-work-item is resolved by the workflow store");
  }
  if (!state) throw new WorkflowError("WORKFLOW_MISSING", "open a workflow before applying commands");
  if (command.action === "revise-acceptance") {
    const request = humanActRequest(state, command);
    if (request) {
      if (!options?.userApproval) {
        throw new WorkflowError("APPROVAL_REQUIRED", "rewording acceptance criteria needs the user's approval: preview it, let the user approve in the client's dialog, then apply. An agent cannot approve it, and in a client without a dialog it is not executed.");
      }
      verifyUserApproval(options.userApproval, { action: "revise-acceptance", subject: request.content });
    }
    return applyPlanningCommand(state, command as PlanningCommand, { now: options?.now, channel: options?.channel, approvedRewording: true });
  }
  if (PLANNING_ACTIONS.has(command.action)) {
    return applyPlanningCommand(state, command as PlanningCommand, { now: options?.now, channel: options?.channel });
  }
  if (command.action === "link-work-item") {
    const same = (link: WorkItemLink) =>
      link.repository === command.target.repository &&
      link.workItemId === command.target.workItemId &&
      link.relation === command.target.relation;
    const current = state.workItem.links ?? [];
    const links = command.remove ? current.filter((link) => !same(link)) : current.some(same) ? current : [...current, command.target];
    const changed = links.length !== current.length;
    return {
      state: changed ? { ...state, workItem: { ...state.workItem, links, revision: state.workItem.revision + 1 } } : state,
      duplicate: !changed,
      result: { workItemId: state.workItem.id, links },
    };
  }
  if (command.action === "add-requirement") {
    const next = addRequirement(state, command);
    return { state: next, duplicate: false, result: { requirementId: command.id } };
  }
  if (command.action === "revise-requirement") {
    const existing = state.requirements.find((r) => r.id === command.id && r.status !== "superseded");
    if (existing && existing.statement === command.statement) {
      return { state, duplicate: true, result: { requirementId: command.id, noChange: true, revision: existing.revision } };
    }
    const next = reviseRequirement(state, command.id, command.statement);
    return { state: next, duplicate: false, result: { requirementId: command.id } };
  }
  if (command.action === "set-service") {
    if (command.service.repositoryId && !state.repositories.some((r) => r.id === command.service.repositoryId)) {
      throw new WorkflowError("REPOSITORY_NOT_FOUND", `service ${command.service.id} names repository ${command.service.repositoryId}, which is not registered (register-repository first)`);
    }
    const previous = state.services.find((service) => service.id === command.service.id);
    const approving = command.service.status === "approved" || command.service.status === "completed";
    const unchanged = previous !== undefined && fingerprintPayload(previous) === fingerprintPayload(command.service);
    if (approving && !unchanged) {
      // Marking a service approved is an act of authority, not a progress note: it needs the user's approval bound
      // to this service as recorded and the implementation under it.
      if (!options?.userApproval) {
        throw new WorkflowError(
          "SERVICE_APPROVAL_REQUIRED",
          `service ${command.service.id} cannot be marked ${command.service.status} by an agent; the user's approval (approve-service) is required`,
        );
      }
      verifyUserApproval(options.userApproval, {
        action: "approve-service",
        subject: humanActContent("approve-service", serviceApprovalSubject(state, command.service)),
      });
    }
    const services = [
      ...state.services.filter((service) => service.id !== command.service.id),
      command.service,
    ];
    return { state: { ...state, services }, duplicate: false, result: featureReadiness({ ...state, services }) };
  }
  if (command.action === "clarify") {
    const asked = questionsToAsk(command.questions);
    const assumptions = [...state.assumptions];
    for (const question of command.questions) {
      if (asked.some((item) => item.id === question.id)) continue;
      if (!question.assumption) continue;
      if (assumptions.some((item) => item.id === `A-${question.id}`)) continue;
      assumptions.push({
        id: `A-${question.id}`,
        statement: question.assumption,
        requirementIds: [],
      });
    }
    const next =
      asked.length > 0 && TRANSITIONS[state.stage].includes("clarification_required")
        ? transition(state, "clarification_required", `clarification requested by ${command.role}`)
        : state;
    return {
      state: { ...next, assumptions },
      duplicate: false,
      result: { questions: asked, continued: state.requirements.map((item) => item.id) },
    };
  }
  if (command.action === "confirm-decision") {
    const decision = state.decisions.find((item) => item.id === command.id);
    if (!decision) throw new WorkflowError("DECISION_NOT_FOUND", `decision ${command.id} is not in this workflow`);
    if (decision.revision !== command.revision) {
      throw new WorkflowError("DECISION_REVISION", `decision ${command.id} revision ${decision.revision} is not ${command.revision}`);
    }
    const contentFingerprint = decisionContentFingerprint(decision);
    if (contentFingerprint !== command.contentFingerprint) {
      throw new WorkflowError("DECISION_FINGERPRINT", `decision ${command.id} content is not the reviewed revision`);
    }
    if (!options?.userApproval) {
      throw new WorkflowError("APPROVAL_REQUIRED", `confirming decision ${decision.id} needs the user's approval: preview it, let the user approve, then apply`);
    }
    verifyUserApproval(options.userApproval, {
      action: "confirm-decision",
      subject: humanActContent("confirm-decision", { decisionId: decision.id, revision: decision.revision, contentFingerprint }),
    });
    const decisions = state.decisions.map((item) => (item.id === decision.id ? { ...item, confirmed: true } : item));
    let confirmed: WorkflowState = { ...state, decisions };
    if (confirmed.stage === "clarification_required" && TRANSITIONS[confirmed.stage].includes("ready")) {
      confirmed = { ...transition(confirmed, "ready", `decision ${command.id} confirmed`), decisions };
    }
    return { state: confirmed, duplicate: false, result: { decisionId: command.id, confirmed: true } };
  }
  if (command.action === "record-decision") {
    if (command.confirmed) {
      throw new WorkflowError(
        "DECISION_CONFIRMATION_REQUIRED",
        "recording a decision cannot confirm it; record it, then confirm the exact revision with the user's approval (confirm-decision)",
      );
    }
    const decisions = [
      ...state.decisions.filter((item) => item.id !== command.id),
      {
        id: command.id,
        statement: command.statement,
        confirmed: command.confirmed,
        revision: state.workItem.revision,
        ...(command.rationale !== undefined ? { rationale: command.rationale } : {}),
        ...(command.notes !== undefined ? { notes: command.notes } : {}),
      },
    ];
    let next: WorkflowState = { ...state, decisions };
    if (
      command.confirmed &&
      next.stage === "clarification_required" &&
      TRANSITIONS[next.stage].includes("ready")
    ) {
      next = transition(next, "ready", `decision ${command.id} confirmed`);
      next = { ...next, decisions };
    }
    return { state: next, duplicate: false, result: { decisionId: command.id, confirmed: command.confirmed } };
  }
  if (command.action === "record-implementation") {
    if (state.mode === "guided" && !state.services.some((s) => s.id === command.serviceId)) {
      throw new WorkflowError("SERVICE_NOT_FOUND", `service ${command.serviceId} is not part of this work item (set-service first): an implementation record needs a service`);
    }
    const implementationUnits = [
      ...state.implementationUnits.filter((unit) => unit.id !== command.id),
      {
        id: command.id,
        serviceId: command.serviceId,
        requirementIds: command.requirementIds,
        path: command.path,
        summary: command.summary,
        ...(command.contractRef ? { contractRef: command.contractRef } : {}),
        stale: false,
      },
    ];
    return {
      state: { ...state, implementationUnits },
      duplicate: false,
      result: { implementationId: command.id, serviceId: command.serviceId },
    };
  }
  if (command.action === "add-story") {
    try {
      assertStoryNarrative(command.narrative);
    } catch (err) {
      throw new WorkflowError(
        "STORY_NARRATIVE",
        err instanceof Error ? err.message : "story narrative is not in the required form",
      );
    }
    if (command.confirmedBehavior) {
      throw new WorkflowError(
        "STORY_CONFIRMATION_REQUIRED",
        "creating a story cannot confirm its behavior; confirm the exact revision after review",
      );
    }
    if (state.stories.some((story) => story.id === command.id && story.status !== "superseded")) {
      throw new WorkflowError("DUPLICATE_STORY", `story ${command.id} already exists`);
    }
    if (state.mode === "guided") {
      // Detailed stories come after an agreed plan, one per planned line: no dozens of stories before the plan is checked.
      const entry = state.storyPlan?.entries.find((item) => item.id === command.id);
      if (acceptanceStatus(state, "story_plan") !== "accepted") {
        throw new WorkflowError("STORY_PLAN_NOT_AGREED", "write and agree the story plan first (set-story-plan, then agree-story-plan); detailed stories follow the agreed plan");
      }
      if (!entry || entry.status === "excluded") {
        throw new WorkflowError("STORY_NOT_IN_PLAN", `story ${command.id} is not a line of the agreed plan; add it to the plan first (update-story-plan)`);
      }
    }
    const entry = state.storyPlan?.entries.find((item) => item.id === command.id);
    // A detailed story keeps what the agreed plan line already said about it unless the command says otherwise.
    const inherit = <T>(given: T[], planned: T[] | undefined): T[] => (given.length > 0 ? given : (planned ?? []));
    const story = UserStorySchema.parse({
      ...command,
      title: command.title ?? entry?.title,
      capabilities: inherit(command.capabilities, entry?.capabilities),
      screenRefs: inherit(command.screenRefs, entry?.screenRefs),
      repositoryIds: inherit(command.repositoryIds, entry?.repositoryIds),
      serviceIds: inherit(command.serviceIds, entry?.serviceIds),
      revision: 1,
      confirmedBehavior: false,
      status: "proposed",
      stale: false,
    });
    const planned = state.storyPlan
      ? { ...state.storyPlan, entries: state.storyPlan.entries.map((entry) => (entry.id === story.id ? { ...entry, status: "detailed" as const } : entry)) }
      : undefined;
    return {
      state: { ...state, stories: [...state.stories, story], ...(planned ? { storyPlan: planned } : {}) },
      duplicate: false,
      result: { storyId: story.id, confirmedBehavior: story.confirmedBehavior },
    };
  }
  if (command.action === "record-context") {
    return {
      state: {
        ...state,
        openQuestions: command.openQuestions ?? state.openQuestions,
        risks: command.risks ?? state.risks,
        blockers: command.blockers ?? state.blockers,
        ...(command.notes !== undefined ? { notes: command.notes } : {}),
      },
      duplicate: false,
      result: { notes: command.notes ?? state.notes },
    };
  }
  if (command.action === "confirm-story") {
    const story = state.stories.find((item) => item.id === command.id && item.status !== "superseded");
    if (!story) throw new WorkflowError("STORY_NOT_FOUND", `story ${command.id} is not in this workflow`);
    if (story.revision !== command.revision) {
      throw new WorkflowError("STORY_REVISION", `story ${command.id} revision ${story.revision} is not ${command.revision}`);
    }
    if (story.acceptanceCriteria.length < 1) {
      throw new WorkflowError("STORY_CONFIRMATION_REQUIRED", `story ${command.id} has no acceptance criteria`);
    }
    const contentFingerprint = storyContentFingerprint(story);
    if (contentFingerprint !== command.contentFingerprint) {
      throw new WorkflowError("STORY_FINGERPRINT", `story ${command.id} content is not the reviewed revision`);
    }
    if (!options?.userApproval) {
      throw new WorkflowError("APPROVAL_REQUIRED", `confirming story ${story.id} needs the user's approval: preview it, let the user approve, then apply`);
    }
    verifyUserApproval(options.userApproval, {
      action: "confirm-story",
      subject: humanActContent("confirm-story", { storyId: story.id, revision: story.revision, contentFingerprint }),
    });
    const stories = state.stories.map((item) =>
      item.id === story.id ? { ...item, confirmedBehavior: true, status: "confirmed" as const } : item,
    );
    return { state: { ...state, stories }, duplicate: false, result: { storyId: story.id, confirmedBehavior: true } };
  }
  if (command.action === "verify-stories" || command.action === "prepare-fix") {
    throw new WorkflowError(
      "EXECUTION_REQUIRED",
      `${command.action} must run in Praxis Runtime so Quality executes the implementation`,
    );
  }
  if (command.action === "locate-repositories") {
    const required = [
      ...new Set([
        ...state.stories.flatMap((story) => story.serviceIds),
        ...state.services.map((service) => service.id),
      ]),
    ];
    const questions = missingRepositoryPrompts({ services: state.services, requiredServiceIds: required });
    return { state, duplicate: false, result: { questions } };
  }
  if (command.action === "record-verification") {
    const kind = options?.evidenceSource?.kind ?? "agent";
    const at = (options?.now ?? new Date()).toISOString();
    if (command.baseCoverageRevision !== undefined && command.baseCoverageRevision !== state.coverageRevision) {
      throw new WorkflowError("EVIDENCE_STALE", `coverage is at revision ${state.coverageRevision}, the writer saw ${command.baseCoverageRevision}: read the work item again and re-run the check`);
    }
    const sourceFor = (): EvidenceSource => ({ ...(options?.evidenceSource ?? {}), kind, artifacts: options?.evidenceSource?.artifacts ?? [] }) as EvidenceSource;
    // what is stored is stamped by the engine: an agent cannot claim a source, a time or a criterion revision for a scenario
    const incoming = command.scenarios.map((scenario) => {
      const requirement = state.requirements.find((r) => r.id === scenario.requirementId && r.status !== "superseded");
      if (!requirement) throw new WorkflowError("EVIDENCE_TARGET_UNKNOWN", `scenario ${scenario.scenarioId} names ${scenario.requirementId}, which is not a current requirement`);
      const story = scenario.storyId ? state.stories.find((item) => item.id === scenario.storyId && item.status !== "superseded") : undefined;
      if (scenario.storyId && !story) throw new WorkflowError("EVIDENCE_TARGET_UNKNOWN", `scenario ${scenario.scenarioId} names story ${scenario.storyId}, which is not current`);
      const ac = requirement.acceptanceCriteria.find((c) => c.id === scenario.acceptanceCriterionId);
      if (!ac && !story?.acceptanceCriteria.some((c) => c.id === scenario.acceptanceCriterionId) && scenario.acceptanceCriterionId !== story?.id) {
        throw new WorkflowError("EVIDENCE_TARGET_UNKNOWN", `scenario ${scenario.scenarioId} names criterion ${scenario.acceptanceCriterionId}, which ${scenario.requirementId} does not have`);
      }
      const storyRevision = story?.revision;
      const stamped = { ...scenario, ...(storyRevision === undefined ? {} : { storyRevision }), ...(ac ? { acceptanceCriterionRevision: ac.revision } : {}), recordedAt: at, source: sourceFor() };
      return stamped.critical || stamped.kind === "happy" ? { ...stamped, critical: true } : stamped;
    });
    const seen = new Set<string>();
    for (const scenario of incoming) {
      if (seen.has(scenario.scenarioId)) throw new WorkflowError("EVIDENCE_ID_CONFLICT", `scenario ${scenario.scenarioId} appears twice in one record`);
      seen.add(scenario.scenarioId);
    }
    const kindOf = (e: { source?: EvidenceSource }) => e.source?.kind ?? "legacy";
    const ownedBy = (e: { source?: EvidenceSource }) => kindOf(e) === kind || (kind === "executed" && kindOf(e) === "legacy");
    let coverage = [...state.coverage];
    const before = JSON.stringify(coverage);
    if (command.retire.length) coverage = coverage.filter((e) => !(command.retire.includes(e.scenarioId) && ownedBy(e)));
    if (command.replaceSource) {
      if (command.replaceSource !== kind) throw new WorkflowError("EVIDENCE_PROTECTED", `a ${kind} record cannot replace ${command.replaceSource} evidence`);
      coverage = coverage.filter((e) => !(ownedBy(e) && !seen.has(e.scenarioId)));
    }
    const comparable = (e: CoverageEntry) => JSON.stringify({ ...e, recordedAt: undefined, source: e.source && { kind: e.source.kind, runner: e.source.runner, subjectDigest: e.source.subjectDigest, artifacts: e.source.artifacts } });
    for (const scenario of incoming) {
      const index = coverage.findIndex((e) => e.scenarioId === scenario.scenarioId);
      if (index < 0) {
        coverage.push(scenario);
        continue;
      }
      const existing = coverage[index]!;
      if (existing.requirementId !== scenario.requirementId || existing.acceptanceCriterionId !== scenario.acceptanceCriterionId) {
        throw new WorkflowError("EVIDENCE_ID_CONFLICT", `scenario ${scenario.scenarioId} already proves ${existing.requirementId} ${existing.acceptanceCriterionId}; a scenario id cannot be moved to another criterion, use a new id`);
      }
      if (kindOf(existing) === "agent" || ownedBy(existing)) {
        // an identical repeat keeps the earlier record (idempotent); a different result replaces it in place
        if (comparable(existing) !== comparable(scenario)) coverage[index] = scenario;
      } else {
        throw new WorkflowError("EVIDENCE_PROTECTED", `scenario ${scenario.scenarioId} was recorded by ${kindOf(existing)} evidence; a ${kind} record cannot overwrite it`);
      }
    }
    const changed = JSON.stringify(coverage) !== before;
    const feature0 = { ...state, coverage, coverageRevision: state.coverageRevision + (changed ? 1 : 0) };
    let next: WorkflowState = {
      ...feature0,
      findings: mergeFindings(state.findings, command.findings),
    };
    if (!command.independentRerun) {
      for (const finding of command.findings.filter((item) => item.status === "open")) {
        const returned = returnFinding(next, finding);
        next = returned.state;
      }
    }
    const touchedServices = [...new Set(incoming.map((scenario) => scenario.serviceId))];
    const serviceVerdicts = [];
    for (const serviceId of touchedServices) {
      const entries = coverage.filter((e) => e.serviceId === serviceId && !e.scenarioId.endsWith("-CONFIRMATION"));
      const current = entries.filter((e) => {
        const story = e.storyId ? next.stories.find((st) => st.id === e.storyId) : undefined;
        return !e.storyId || (story && story.status !== "superseded" && (e.storyRevision ?? 1) === story.revision);
      });
      const rolled = rollupStoryVerdict(current);
      const independent = current.some((e) => e.status === "PASS" && (e.source?.kind ?? "legacy") !== "agent");
      const verdict = rolled.verdict === "PASS" && !independent ? "PASS_WITH_RISKS" : rolled.verdict;
      const reasons = rolled.verdict === "PASS" && !independent ? ["only agent-attested results: not independently executed"] : rolled.reasons;
      serviceVerdicts.push({ serviceId, verdict, reasons });
      next = recordVerdict(next, {
        id: `V-SERVICE-${serviceId}-${next.verdicts.length + 1}`,
        scope: "service",
        scopeId: serviceId,
        verdict,
        evidenceRefs: reasons.length ? reasons : [`${serviceId} scenarios passed`],
        requirementIds: [...new Set(current.map((e) => e.requirementId))],
      });
    }
    for (const requirementId of [...new Set(incoming.map((scenario) => scenario.requirementId))]) {
      const cov = requirementCoverage(next, requirementId);
      if (cov.noEvidence) continue;
      const evidence = requirementEvidence(next, requirementId);
      if (evidence.status !== "executed") continue;
      next = recordVerdict(next, {
        id: `V-${requirementId}-${next.verdicts.length + 1}`,
        scope: "requirement",
        scopeId: requirementId,
        verdict: evidence.verdict,
        evidenceRefs: [
          ...(command.independentRerun ? ["independentRerun:true"] : ["independentRerun:false"]),
          ...evidence.reasons,
          ...evidence.provenance,
        ],
        requirementIds: [requirementId],
      });
    }
    // the feature result is the same computation feature-verdict uses over the evidence; readiness (approvals) is added there
    const evaluation = evaluateEvidence(next);
    const verdictId = `V-STORY-${next.verdicts.length + 1}`;
    next = recordVerdict(next, {
      id: verdictId,
      scope: "feature",
      scopeId: state.workItem.id,
      verdict: evaluation.verdict,
      evidenceRefs: [
        ...(command.testsGreen ? ["testsGreen:true", "green tests are not story evidence"] : []),
        ...(command.independentRerun ? ["independentRerun:true"] : ["independentRerun:false"]),
        `criteria: ${evaluation.totals.passed} of ${evaluation.totals.total} passed`,
        ...evaluation.gaps,
      ],
      requirementIds: requiredRequirements(next).map((r) => r.id),
    });
    return {
      state: next,
      duplicate: false,
      result: {
        verdict: evaluation.verdict,
        reasons: evaluation.gaps,
        scenarios: incoming,
        serviceVerdicts,
        coverage: { totals: evaluation.totals, requirements: evaluation.requirements, stories: evaluation.stories },
        coverageRevision: next.coverageRevision,
        evidenceSource: kind,
      },
    };
  }
  if (command.action === "record-change") {
    const changes = [...state.changes.filter((item) => item.id !== command.change.id), command.change];
    return {
      state: { ...state, changes },
      duplicate: false,
      result: {
        changeId: command.change.id,
        commitSha: command.change.commitSha,
        changeRequest: command.change.changeRequest ?? null,
        mrStatus: command.change.mrStatus,
        resolved: false,
      },
    };
  }
  if (command.action === "feature-verdict") {
    const feature = evaluateFeature(state);
    const verdictId = `V-FEATURE-${state.verdicts.length + 1}`;
    const next = recordVerdict(state, {
      id: verdictId,
      scope: "feature",
      scopeId: state.workItem.id,
      verdict: feature.verdict,
      evidenceRefs: feature.gaps.length ? feature.gaps : ["feature trace complete"],
      requirementIds: state.requirements.map((item) => item.id),
    });
    return { state: next, duplicate: false, result: feature };
  }
  if (command.action === "handoff") {
    const carried = carryForwardContext(state, command);
    const created = createHandoff(state, {
      sourceRole: command.sourceRole,
      targetRole: command.targetRole,
      serviceIds: command.serviceIds,
      requirementIds: command.requirementIds,
      acceptanceCriterionIds: state.requirements
        .filter((item) => command.requirementIds.includes(item.id))
        .flatMap((item) => item.acceptanceCriteria.map((criterion) => criterion.id)),
      storyIds: state.stories
        .filter(
          (story) =>
            story.status !== "superseded" &&
            story.requirementIds.some((id) => command.requirementIds.includes(id)),
        )
        .map((story) => story.id),
      artifactRefs: state.implementationUnits
        .filter((unit) => !unit.stale && command.serviceIds.includes(unit.serviceId))
        .map((unit) => ({
          id: unit.id,
          path: unit.path,
          revision: unit.requirementIds.reduce(
            (max, id) =>
              Math.max(max, state.requirements.find((item) => item.id === id)?.revision ?? 1),
            1,
          ),
          role: command.sourceRole,
        })),
      decisions: state.decisions.map((d) => d.id),
      decisionRecords: state.decisions.map((d) => ({ ...d })),
      assumptions: carried.assumptions,
      openQuestions: carried.openQuestions,
      risks: carried.risks,
      blockers: carried.blockers,
      ...(carried.notes !== undefined ? { notes: carried.notes } : {}),
      resolved: command.resolved,
      nextActions: command.nextActions,
      readiness: command.readiness,
      evidenceRefs: state.implementationUnits
        .filter((unit) => !unit.stale)
        .map((unit) => `${unit.serviceId}:${unit.path}`),
    });
    return {
      state: created.state,
      duplicate: created.duplicate,
      result: { handoffId: created.handoff.handoffId, duplicate: created.duplicate },
    };
  }
  if (command.action !== "quality-check") {
    throw new WorkflowError("COMMAND_UNRESOLVED", "unsupported workflow command");
  }
  const observedBehavior = command.implementationSource
    ? inspectImportImplementation(command.implementationSource)
    : (command.observedBehavior ?? "unspecified");
  const check = evaluateRequirementBehavior({
    requirementId: command.requirementId,
    statement:
      state.requirements.find((r) => r.id === command.requirementId)?.statement ?? "",
    observedBehavior,
    testsGreen: command.testsGreen,
    developerClaimsPass: command.developerClaimsPass,
  });
  const executed = requirementEvidence(state, command.requirementId);
  const implementationEvidence: string[] = [];
  if (command.implementationSource) {
    implementationEvidence.push(`implementation:${fingerprintPayload(command.implementationSource)}`);
    if (command.observedBehavior && command.observedBehavior !== observedBehavior) {
      implementationEvidence.push(`unsupported-claim:${command.observedBehavior}`);
    }
  }
  const serviceIds = (fallback: string[]) => (command.serviceId ? [command.serviceId] : fallback);
  let verdict: QualityVerdict;
  let evidence: string[];
  let finding: Finding | undefined;
  if (check.verdict === "FAIL" || executed.status === "missing") {
    // The heuristic FAIL always wins; without executed coverage the heuristic is all we have.
    verdict = check.verdict;
    evidence = [...(check.finding?.evidence ?? [`observed:${observedBehavior}`]), ...implementationEvidence];
    finding = check.finding
      ? { ...check.finding, serviceIds: serviceIds(check.finding.serviceIds), evidence }
      : undefined;
  } else {
    verdict = executed.verdict;
    evidence = [...executed.reasons, ...executed.provenance, ...implementationEvidence];
    // An unconfirmed Story is a BA confirmation risk, not a Developer defect.
    finding =
      executed.verdict === "FAIL" && executed.counts.failed > 0
        ? {
            id: `F-${command.requirementId}-coverage`,
            requirementIds: [command.requirementId],
            serviceIds: serviceIds([]),
            owner: "developer",
            summary: `${command.requirementId} failed executed verification: ${executed.reasons.join("; ")}`,
            evidence,
            status: "open",
          }
        : undefined;
  }
  let next = state;
  if (finding) {
    const returned = returnFinding(next, finding);
    next = returned.state;
  }
  const verdictId = `V-${command.requirementId}-${next.verdicts.length + 1}`;
  next = recordVerdict(next, {
    id: verdictId,
    scope: "requirement",
    scopeId: command.requirementId,
    verdict,
    evidenceRefs: evidence,
    requirementIds: [command.requirementId],
  });
  return {
    state: next,
    duplicate: false,
    result: {
      verdict,
      observedBehavior,
      evidenceStatus: executed.status,
      finding: finding ?? null,
    },
  };
}

function mergeFindings(current: Finding[], incoming: Finding[]): Finding[] {
  const merged = new Map(current.map((finding) => [finding.id, finding]));
  for (const finding of incoming) merged.set(finding.id, finding);
  return [...merged.values()];
}

export function evaluateFeature(state: WorkflowState): { verdict: QualityVerdict; gaps: string[]; evidence: FeatureEvaluation; readinessGaps: string[] } {
  const evidence = evaluateEvidence(state);
  const readinessGaps: string[] = [];
  for (const service of state.services) {
    const unit = state.implementationUnits.find((item) => item.serviceId === service.id && !item.stale);
    if (!unit) readinessGaps.push(`missing implementation for ${service.id}`);
  }
  const readiness = featureReadiness(state);
  if (!readiness.ready) {
    for (const id of readiness.missingIntegration) readinessGaps.push(`dependency not done: ${id}`);
    for (const dep of readiness.unknownDependencies) readinessGaps.push(`unknown dependency: ${dep}`);
    if (state.services.length === 0) readinessGaps.push("no services");
    else if (!state.services.every((service) => service.status === "approved" || service.status === "completed")) {
      readinessGaps.push("services are not approved");
    }
  }
  const gaps = [...evidence.gaps, ...readinessGaps];
  const verdict: QualityVerdict = readinessGaps.length > 0 ? "FAIL" : evidence.verdict;
  return { verdict, gaps, evidence, readinessGaps };
}

export const BULK_IMPORT_REQUIREMENTS: Array<{
  id: string;
  statement: string;
  acceptanceCriteria: string[];
  serviceIds: string[];
}> = [
  {
    id: "REQ-BUI-001",
    statement: "Invalid CSV rows must not prevent valid users from being imported.",
    acceptanceCriteria: [
      "A file with mixed valid and invalid rows imports the valid rows.",
      "Invalid rows appear in the failed-row report.",
    ],
    serviceIds: ["api", "worker", "identity"],
  },
  {
    id: "REQ-BUI-002",
    statement: "An organization admin can upload a CSV of email, name, and role up to 10,000 rows.",
    acceptanceCriteria: ["Uploads over 10,000 rows are rejected before execution."],
    serviceIds: ["api", "frontend"],
  },
  {
    id: "REQ-BUI-003",
    statement: "Import execution is asynchronous and reports progress.",
    acceptanceCriteria: ["The admin can observe progress before completion."],
    serviceIds: ["api", "worker", "frontend"],
  },
  {
    id: "REQ-BUI-004",
    statement: "Retries are idempotent and do not create duplicate users.",
    acceptanceCriteria: ["Replaying a completed row does not create a second user."],
    serviceIds: ["worker", "identity"],
  },
];
