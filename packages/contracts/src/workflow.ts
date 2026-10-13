import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Jira-independent workflow domain.
 * Existing handoff schemas stay valid. This module adds stable local identity,
 * bidirectional handoffs, traceability, and capability routing.
 */

export const WORKFLOW_CONTRACT_VERSION = "1.0.0";

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
export const RequirementIdSchema = z
  .string()
  .regex(/^(REQ-[A-Z][A-Z0-9]*-\d{3,}|[A-Z][A-Z0-9]*-(?:FR|NFR|BR)\d+)$/);

export const WorkItemSourceSchema = z.enum([
  "local",
  "markdown",
  "repository",
  "jira",
]);

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

export class WorkflowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

export const WorkItemSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  source: WorkItemSourceSchema,
  /** Optional external key. Never the work item's identity. */
  jiraIssueKey: z.string().min(1).optional(),
  status: WorkflowStageSchema,
  revision: z.number().int().nonnegative(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  requirementId: RequirementIdSchema,
  statement: z.string().min(1),
  revision: z.number().int().positive(),
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
  version: z.literal(WORKFLOW_CONTRACT_VERSION),
  workflowId: z.string().min(1),
  workItemId: z.string().min(1),
  handoffId: z.string().min(1),
  sourceRole: WorkflowRoleSchema,
  targetRole: WorkflowRoleSchema,
  serviceIds: z.array(z.string()),
  requirementIds: z.array(RequirementIdSchema),
  acceptanceCriterionIds: z.array(z.string()),
  artifactRefs: z.array(ArtifactRefSchema),
  decisions: z.array(z.string()),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  blockers: z.array(z.string()),
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
  version: z.literal(WORKFLOW_CONTRACT_VERSION),
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
    }),
  ),
  assumptions: z.array(
    z.object({
      id: z.string(),
      statement: z.string(),
      requirementIds: z.array(RequirementIdSchema),
    }),
  ),
  stage: WorkflowStageSchema,
  history: z.array(
    z.object({
      revision: z.number().int().positive(),
      stage: WorkflowStageSchema,
      note: z.string(),
    }),
  ),
});
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

const SECRET_KEY =
  /token|secret|password|authorization|api[_-]?key|private[_-]?key/i;

export function redactPersistent<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactPersistent(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactPersistent(child);
    }
    return out as T;
  }
  if (typeof value === "string" && /^(Bearer\s+)?[A-Za-z0-9_\-]{40,}$/.test(value)) {
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

export function openLocalWorkflow(input: {
  projectId: string;
  title: string;
  source?: WorkItem["source"];
  jiraIssueKey?: string;
  request: string;
}): WorkflowState {
  const slug = input.title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const workItemId = `WI-${slug || "WORK"}-001`;
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
    },
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
    })),
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
  return {
    ...state,
    requirements: state.requirements.map((r) => (r.id === id ? revised : r)),
    verdicts,
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
  > & { supersedes?: string },
): { state: WorkflowState; handoff: RoleHandoff; duplicate: boolean } {
  const body = {
    workflowId: state.workflowId,
    workItemId: state.workItem.id,
    sourceRole: input.sourceRole,
    targetRole: input.targetRole,
    serviceIds: input.serviceIds,
    requirementIds: input.requirementIds,
    acceptanceCriterionIds: input.acceptanceCriterionIds,
    artifactRefs: input.artifactRefs,
    decisions: input.decisions,
    assumptions: input.assumptions,
    openQuestions: input.openQuestions,
    risks: input.risks,
    blockers: input.blockers,
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
  missingIntegration: string[];
} {
  const serviceStatus: Record<string, WorkflowStage> = {};
  for (const service of state.services) serviceStatus[service.id] = service.status;
  const done = (status: WorkflowStage) => status === "approved" || status === "completed";
  const missingIntegration = state.services
    .filter((service) =>
      service.dependsOn.some((dep) => {
        const upstream = state.services.find((item) => item.id === dep);
        return !upstream || !done(upstream.status);
      }),
    )
    .map((service) => service.id);
  const ready = state.services.length > 0 && state.services.every((service) => done(service.status));
  return { ready, serviceStatus, missingIntegration };
}

const PARTIAL_SUCCESS =
  /invalid[^.]*must not (?:prevent|block)[^.]*valid/i;

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
    action: z.literal("quality-check"),
    requirementId: RequirementIdSchema,
    observedBehavior: z.enum(["partial-success", "all-or-nothing", "unspecified"]),
    testsGreen: z.boolean().optional(),
    developerClaimsPass: z.boolean().optional(),
  }),
]);
export type WorkflowCommand = z.infer<typeof WorkflowCommandSchema>;

export function commandFingerprint(command: WorkflowCommand): string {
  return fingerprintPayload(command);
}

export function applyWorkflowCommand(
  state: WorkflowState | null,
  raw: WorkflowCommand | unknown,
): { state: WorkflowState; duplicate: boolean; result: unknown } {
  const command = WorkflowCommandSchema.parse(raw);
  if (command.action === "open") {
    if (state) return { state, duplicate: true, result: { workflowId: state.workflowId } };
    const opened = openLocalWorkflow(command);
    return { state: opened, duplicate: false, result: { workflowId: opened.workflowId, workItemId: opened.workItem.id } };
  }
  if (!state) throw new WorkflowError("WORKFLOW_MISSING", "open a workflow before applying commands");
  if (command.action === "add-requirement") {
    const next = addRequirement(state, command);
    return { state: next, duplicate: false, result: { requirementId: command.id } };
  }
  if (command.action === "revise-requirement") {
    const next = reviseRequirement(state, command.id, command.statement);
    return { state: next, duplicate: false, result: { requirementId: command.id } };
  }
  if (command.action === "set-service") {
    const services = [
      ...state.services.filter((service) => service.id !== command.service.id),
      command.service,
    ];
    return { state: { ...state, services }, duplicate: false, result: featureReadiness({ ...state, services }) };
  }
  if (command.action === "handoff") {
    const created = createHandoff(state, {
      sourceRole: command.sourceRole,
      targetRole: command.targetRole,
      serviceIds: command.serviceIds,
      requirementIds: command.requirementIds,
      acceptanceCriterionIds: [],
      artifactRefs: [],
      decisions: state.decisions.filter((d) => d.confirmed).map((d) => d.id),
      assumptions: command.assumptions,
      openQuestions: command.openQuestions,
      risks: [],
      blockers: command.blockers,
      nextActions: command.nextActions,
      readiness: command.readiness,
      evidenceRefs: [],
    });
    return {
      state: created.state,
      duplicate: created.duplicate,
      result: { handoffId: created.handoff.handoffId, duplicate: created.duplicate },
    };
  }
  const check = evaluateRequirementBehavior({
    requirementId: command.requirementId,
    statement:
      state.requirements.find((r) => r.id === command.requirementId)?.statement ?? "",
    observedBehavior: command.observedBehavior,
    testsGreen: command.testsGreen,
    developerClaimsPass: command.developerClaimsPass,
  });
  let next = state;
  if (check.finding) {
    const returned = returnFinding(next, check.finding);
    next = returned.state;
  }
  const verdictId = `V-${command.requirementId}-${next.verdicts.length + 1}`;
  next = recordVerdict(next, {
    id: verdictId,
    scope: "requirement",
    scopeId: command.requirementId,
    verdict: check.verdict,
    evidenceRefs: check.finding?.evidence ?? [`observed:${command.observedBehavior}`],
    requirementIds: [command.requirementId],
  });
  return { state: next, duplicate: false, result: { verdict: check.verdict, finding: check.finding ?? null } };
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
