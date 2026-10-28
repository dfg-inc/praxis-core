import { z } from "zod";

/** Contract version envelope for all inter-role artifacts. */
export const ContractMetaSchema = z.object({
  contract: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});

/** BA → Architect: work package handoff. */
export const BaToArchitectHandoffSchema = ContractMetaSchema.extend({
  contract: z.literal("ba.architect.handoff"),
  workPackageId: z.string().min(1),
  workPackagePath: z.string().min(1),
  requirementIds: z.array(z.string()).min(1),
  visionConfirmed: z.boolean(),
  readinessChecks: z.array(
    z.object({
      id: z.string(),
      passed: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
});
export type BaToArchitectHandoff = z.infer<typeof BaToArchitectHandoffSchema>;

/** Architect → Developer: design package + context slice. */
export const ArchitectToDeveloperHandoffSchema = ContractMetaSchema.extend({
  contract: z.literal("architect.developer.handoff"),
  workPackageId: z.string().min(1),
  designPackagePath: z.string().min(1),
  contextSlicePath: z.string().min(1),
  decisionIds: z.array(z.string()),
  features: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      estimateHours: z.number().nonnegative().optional(),
      dependsOn: z.array(z.string()).optional(),
      readyForDev: z.boolean(),
    }),
  ),
  /** Platform/interface contract ids visible to Developer (WBS 4.9). */
  platformContractIds: z.array(z.string()).optional(),
});
export type ArchitectToDeveloperHandoff = z.infer<
  typeof ArchitectToDeveloperHandoffSchema
>;

/**
 * One deterministic file operation in a change-spec.
 * - `edit` (default): match→replace on an existing file (idempotent).
 * - `create`: write full content when absent; succeed if already equal;
 *   fail on conflicting unexpected content (never silent overwrite).
 * Legacy `write` is accepted as an alias for create content.
 */
export const ChangeSpecChangeSchema = z
  .object({
    file: z.string().min(1),
    description: z.string().optional(),
    op: z.enum(["edit", "create"]).optional(),
    match: z.string().optional(),
    replace: z.string().optional(),
    content: z.string().optional(),
    /** @deprecated Prefer `content` with `op: "create"`. */
    write: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    const op =
      c.op ??
      (c.content !== undefined || c.write !== undefined ? "create" : "edit");
    if (op === "edit") {
      if (c.match === undefined || c.replace === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "edit changes require match and replace",
        });
      }
    } else if (op === "create") {
      if (c.content === undefined && c.write === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "create changes require content (or legacy write)",
        });
      }
    }
  });
export type ChangeSpecChange = z.infer<typeof ChangeSpecChangeSchema>;

/** Machine acceptance check Quality / Developer can execute. */
export const AcceptanceCheckSchema = z.union([
  z.object({
    type: z.literal("contains").optional(),
    file: z.string().min(1),
    contains: z.string().min(1),
  }),
  z.object({
    type: z.literal("npm-test"),
  }),
]);
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

/** Architect machine change-spec (Developer execution input). */
export const ChangeSpecSchema = z.object({
  workPackageId: z.string().min(1).optional(),
  requirementIds: z.array(z.string()).optional(),
  decisionIds: z.array(z.string()).optional(),
  productRootHint: z.string().optional(),
  researchGlobs: z.array(z.string()).optional(),
  changes: z.array(ChangeSpecChangeSchema).min(1),
  acceptanceChecks: z.array(AcceptanceCheckSchema).optional(),
  features: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        estimateHours: z.number().nonnegative().optional(),
        dependsOn: z.array(z.string()).optional(),
        readyForDev: z.boolean(),
      }),
    )
    .min(1),
  design: z.record(z.unknown()).optional(),
  /** Repo-relative paths that MUST appear in changes[].file before readyForDev. */
  requiredMachineFiles: z.array(z.string()).optional(),
  verificationPolicy: z
    .object({
      requireTests: z.boolean().optional(),
      requireBuild: z.boolean().optional(),
      requireLint: z.boolean().optional(),
    })
    .optional(),
});
export type ChangeSpec = z.infer<typeof ChangeSpecSchema>;

/** Normalize a change entry: resolve op + content aliases. */
export function normalizeChange(c: ChangeSpecChange): {
  file: string;
  description?: string;
  op: "edit" | "create";
  match?: string;
  replace?: string;
  content?: string;
} {
  const op =
    c.op ??
    (c.content !== undefined || c.write !== undefined ? "create" : "edit");
  if (op === "create") {
    return {
      file: c.file,
      description: c.description,
      op: "create",
      content: c.content ?? c.write,
    };
  }
  return {
    file: c.file,
    description: c.description,
    op: "edit",
    match: c.match,
    replace: c.replace,
  };
}

/**
 * One verification check result.
 * Distinguishes executed pass/fail from skipped / not-required.
 */
export const VerificationCheckSchema = z.object({
  status: z.enum(["passed", "failed", "skipped"]),
  required: z.boolean(),
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

/** Structured verification block for Developer → Quality. */
export const VerificationSchema = z.object({
  build: VerificationCheckSchema,
  tests: VerificationCheckSchema,
  lint: VerificationCheckSchema,
  packageCriteria: VerificationCheckSchema,
});
export type Verification = z.infer<typeof VerificationSchema>;

/** Developer → Quality: merge request intent. */
export const DeveloperToQualityHandoffSchema = ContractMetaSchema.extend({
  contract: z.literal("developer.quality.handoff"),
  /** Work package this handoff claims to deliver (required identity). */
  workPackageId: z.string().min(1),
  mergeRequestRef: z.string().min(1),
  intention: z.string().min(1),
  requirementIds: z.array(z.string()),
  decisionIds: z.array(z.string()),
  verification: VerificationSchema,
  /** Optional machine AC checks Quality can execute against the product tree. */
  acceptanceChecks: z.array(AcceptanceCheckSchema).optional(),
  jiraWorkPackageKey: z.string().optional(),
  canonicalStoryKeys: z.array(z.string()).optional(),
  evidencePath: z.string().optional(),
});
export type DeveloperToQualityHandoff = z.infer<
  typeof DeveloperToQualityHandoffSchema
>;

export const DeveloperCompletionEvidenceSchema = ContractMetaSchema.extend({
  contract: z.literal("developer.completion.evidence"),
  workPackageId: z.string().min(1),
  jiraWorkPackageKey: z.string().min(1),
  canonicalStoryKeys: z.array(z.string()),
  requirementIds: z.array(z.string()),
  implementationScope: z.array(z.string()),
  changedProductFiles: z.array(z.string()),
  acceptanceChecks: z.array(AcceptanceCheckSchema),
  verification: z.object({
    command: z.string().min(1),
    exitCode: z.number(),
    ok: z.boolean(),
    passed: z.number().optional(),
    failed: z.number().optional(),
    total: z.number().optional(),
    timestamp: z.string().min(1),
  }),
  implementationStatus: z.literal("complete"),
  readyForQuality: z.literal(true),
});
export type DeveloperCompletionEvidence = z.infer<
  typeof DeveloperCompletionEvidenceSchema
>;

/** Quality ← local CI / Developer MR payload (WBS 6.2). Live remote provider is out of band. */
export const QualityMrContextSchema = ContractMetaSchema.extend({
  contract: z.literal("quality.mr.context"),
  projectId: z.string().min(1),
  workPackageId: z.string().min(1),
  mergeRequestRef: z.string().min(1),
  repositoryPath: z.string().min(1),
  baseBranch: z.string().min(1),
  headBranch: z.string().min(1),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  changedFiles: z.array(z.string()),
  requirementIds: z.array(z.string()),
  decisionIds: z.array(z.string()),
  verification: VerificationSchema.optional(),
  qualityHandoff: DeveloperToQualityHandoffSchema.optional(),
});
export type QualityMrContext = z.infer<typeof QualityMrContextSchema>;

export const QualityAuditReportSchema = ContractMetaSchema.extend({
  contract: z.literal("quality.audit.report"),
  auditId: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  auditedPath: z.string().min(1),
  timestamp: z.string().min(1),
  scope: z.string().min(1),
  checksPerformed: z.array(z.string()),
  findings: z.array(z.unknown()),
  findingsBySeverity: z.record(z.number()),
  findingsByCategory: z.record(z.number()),
  evidence: z.array(z.string()),
  summary: z.object({
    total: z.number(),
    blocking: z.number(),
    warnings: z.number(),
  }),
  verdict: z.enum(["pass", "fail"]),
  remediation: z.array(z.string()),
  unresolvedHighRisk: z.array(z.unknown()),
  tool: z.object({
    name: z.string(),
    version: z.string(),
  }),
});
export type QualityAuditReport = z.infer<typeof QualityAuditReportSchema>;

export const QualityRollbackEventSchema = ContractMetaSchema.extend({
  contract: z.literal("quality.rollback.event"),
  projectId: z.string().min(1),
  workPackageId: z.string().optional(),
  mergeRequestRef: z.string().min(1),
  affectedRef: z.string().min(1),
  reason: z.string().min(1),
  trigger: z.string().min(1),
  timestamp: z.string().optional(),
  reviewId: z.number().int().positive().optional(),
  findingIds: z.array(z.string()).optional(),
  status: z.string().min(1),
  evidence: z.string().min(1),
});
export type QualityRollbackEvent = z.infer<typeof QualityRollbackEventSchema>;

export const QualityHotfixEventSchema = ContractMetaSchema.extend({
  contract: z.literal("quality.hotfix.event"),
  projectId: z.string().min(1),
  rollbackId: z.number().int().positive(),
  hotfixRef: z.string().min(1),
  reason: z.string().min(1),
  workPackageId: z.string().optional(),
  reviewId: z.number().int().positive().optional(),
  verification: z.string().min(1),
  timestamp: z.string().optional(),
});
export type QualityHotfixEvent = z.infer<typeof QualityHotfixEventSchema>;

export const QualityReturnEventSchema = ContractMetaSchema.extend({
  contract: z.literal("quality.return.event"),
  projectId: z.string().min(1),
  workPackageId: z.string().min(1),
  mergeRequestRef: z.string().min(1),
  reviewId: z.number().int().positive(),
  targetRole: z.literal("developer"),
  blockingFindingIds: z.array(z.string()).min(1),
  reason: z.string().min(1),
  source: z.enum(["qa", "code-review"]),
  status: z.enum(["open", "resolved"]),
  returnedAt: z.string().optional(),
  resolvedAt: z.string().optional(),
  followUpReviewId: z.number().int().positive().optional(),
});
export type QualityReturnEvent = z.infer<typeof QualityReturnEventSchema>;

export const QualityNormProposalSchema = ContractMetaSchema.extend({
  contract: z.literal("quality.norm.proposal"),
  fingerprint: z.string().min(1),
  occurrenceCount: z.number().int().positive(),
  sourceIds: z.array(z.string()).min(1),
  evidence: z.string().min(1),
  proposedRuleId: z.string().min(1),
  topic: z.string().min(1),
  projectId: z.string().min(1),
  status: z.literal("proposed"),
  createdBy: z.literal("quality"),
  binding: z.literal(false),
});
export type QualityNormProposal = z.infer<typeof QualityNormProposalSchema>;

/** True when every required check passed and no check failed. */
export function verificationIsReady(v: Verification): boolean {
  const checks = [v.build, v.tests, v.lint, v.packageCriteria];
  for (const c of checks) {
    if (c.status === "failed") return false;
    if (c.required && c.status !== "passed") return false;
  }
  return true;
}

/**
 * Map an arbiter step into a structured verification check.
 * Skipped / missing steps are never reported as passed.
 */
export function verificationCheckFromArbiterStep(
  step: { ok?: boolean; skipped?: boolean } | undefined,
  required: boolean,
): VerificationCheck {
  if (!step || step.skipped) {
    return { status: required ? "failed" : "skipped", required };
  }
  return { status: step.ok ? "passed" : "failed", required };
}

/** Compute packageCriteria from build/tests/lint structured checks. */
export function computePackageCriteria(
  build: VerificationCheck,
  tests: VerificationCheck,
  lint: VerificationCheck,
): VerificationCheck {
  const parts = [build, tests, lint];
  const failed = parts.some((c) => c.status === "failed");
  const requiredMissing = parts.some(
    (c) => c.required && c.status !== "passed",
  );
  return {
    status: failed || requiredMissing ? "failed" : "passed",
    required: true,
  };
}

export function parseContract<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> {
  return schema.parse(data);
}

export {
  GitHostProviderSchema,
  CreateMergeRequestRequestSchema,
  CiProviderPreviewSchema,
  validateGitHostConfig,
  buildCreateMergeRequestRequest,
  buildCiContextRequest,
  qualityServiceUnavailableStep,
} from "./git-host.js";
export type {
  GitHostProvider,
  CreateMergeRequestRequest,
  CiProviderPreview,
} from "./git-host.js";

export {
  WORKFLOW_CONTRACT_VERSION,
  WorkflowStageSchema,
  WorkflowRoleSchema,
  ClarificationClassSchema,
  SideEffectSchema,
  QualityVerdictSchema,
  RequirementIdSchema,
  WorkItemSchema,
  RequirementSchema,
  ServiceSchema,
  RoleHandoffSchema,
  FindingSchema,
  VerdictRecordSchema,
  CapabilitySchema,
  WorkflowStateSchema,
  WorkflowError,
  redactPersistent,
  redactState,
  assertTransition,
  transition,
  openLocalWorkflow,
  addRequirement,
  reviseRequirement,
  createHandoff,
  resumeWorkflow,
  featureReadiness,
  evaluateFeature,
  evaluateRequirementBehavior,
  recordVerdict,
  requirementEvidence,
  type RequirementEvidence,
  workItemIdFor,
  WorkItemLinkSchema,
  WorkItemRelationSchema,
  type WorkItemLink,
  returnFinding,
  classifyClarification,
  questionsToAsk,
  routeCapabilities,
  classifyJiraFailure,
  diagnoseCompatibility,
  WorkflowCommandSchema,
  parseWorkflowCommand,
  dryRunCommand,
  commandFingerprint,
  applyWorkflowCommand,
  storyContentFingerprint,
  decisionContentFingerprint,
  humanActRequest,
  serviceApprovalSubject,
  exportWorkflowSnapshot,
  renderWorkflowSnapshotHtml,
  BULK_IMPORT_REQUIREMENTS,
  WorkTrackingProviderSchema,
} from "./workflow.js";
export {
  ACTION_PLAN_CONTRACT,
  ACTION_PLAN_VERSION,
  ActionPlanSchema,
  DecisionKindSchema,
  DECISION_KIND_OPERATIONS,
  SINGLE_AUTHORITY_OPERATIONS,
  authorityProblems,
  decisionKindFor,
  actionPlanFingerprint,
  buildActionPlan,
  renderActionPlanForHuman,
} from "./action-plan.js";
export type { ActionPlan, DecisionKind } from "./action-plan.js";
export {
  StoryIdSchema,
  UserStorySchema,
  CoverageStatusSchema,
  CoverageEntrySchema,
  ChangeRecordSchema,
  missingRepositoryPrompts,
  rollupStoryVerdict,
  assertStoryNarrative,
} from "./story.js";
export type { StoryId, UserStory, CoverageStatus, CoverageEntry, ChangeRecord } from "./story.js";
export type {
  WorkflowStage,
  WorkflowRole,
  ClarificationClass,
  SideEffect,
  QualityVerdict,
  WorkTrackingProvider,
  WorkItem,
  AcceptanceCriterion,
  Requirement,
  Service,
  RoleHandoff,
  Finding,
  VerdictRecord,
  Capability,
  WorkflowState,
  JiraFailureKind,
  WorkflowCommand,
} from "./workflow.js";

export {
  PraxisRoleSchema,
  PraxisRichTextDocumentSchema,
  EpicLifecycleSchema,
  TicketLifecycleSchema,
  WorkPackageLifecycleSchema,
  WorkPackageClaimSchema,
  PraxisWorkPackageSchema,
  JiraBaHandoffSchema,
  JiraBaProposalSchema,
  JiraWriteJournalEntrySchema,
  JiraOperationJournalEntrySchema,
  BaJiraWritePlanItemSchema,
  QualityWpReportSchema,
} from "./jira-orchestration.js";
export type {
  PraxisRole,
  RichTextInline,
  RichTextBlock,
  PraxisRichTextDocument,
  EpicLifecycle,
  TicketLifecycle,
  WorkPackageLifecycle,
  WorkPackageClaim,
  PraxisWorkPackage,
  JiraBaHandoff,
  JiraBaProposal,
  JiraBaProposalStory,
  JiraWriteJournalEntry,
  JiraWriteOpState,
  JiraOperationJournalEntry,
  BaJiraWriteAction,
  BaJiraWritePlanItem,
  QualityWpReport,
} from "./jira-orchestration.js";
export {
  PUBLICATION_OPERATIONS,
  ApprovalOperationSchema,
  canonicalize,
} from "./approval.js";
export type { ApprovalOperation } from "./approval.js";
export type { GitDescribed, GitOperationKind } from "./git-describe.js";
export { HUMAN_ACT_KIND, humanActContent, humanActApprovalRequest } from "./human-acts.js";
export { approvalFor, runApprovedForTest } from "./human-act-testing.js";
export type { HumanAct } from "./human-acts.js";
export type { HumanActRequest } from "./workflow.js";
export {
  USER_APPROVAL_CONTRACT,
  USER_APPROVAL_VERSION,
  USER_APPROVAL_TTL_MS,
  ApprovalError,
  ApprovalNeedsInput,
  createUserApproval,
  obtainUserApproval,
  verifyUserApproval,
  subjectDigest,
  withApprovalChannel,
  currentApprovalChannel,
  approvalModeReport,
  decisionLogPath,
  approvalsGivenInThisCall,
  logDecision,
  hasMutationLease,
  requireMutationLease,
  runWorkflowRecordWrite,
  runApprovedMutation,
} from "./user-approval.js";
export type {
  ApprovalErrorCode,
  ApprovalAssurance,
  ApprovalChannelKind,
  ApprovalRequest,
  AskAnswer,
  DecisionLogEntry,
  UserApproval,
  UserApprovalChannel,
} from "./user-approval.js";

// Planning: stages, scope and review, prototype, story plan, story editing, repositories, impact, next step.
export * from "./planning-schemas.js";
export {
  PlanningCommandSchemas,
  PLANNING_ACTIONS,
  analyzeStoryCoverage,
  acceptanceStatus,
  applyPlanningCommand,
  currentFingerprint,
  expectedCapabilities,
  inferCapabilities,
  inferPhase,
  migrateWorkflowState,
  nextStep,
  phaseGates,
  phaseIndex,
  prototypeFingerprint,
  requirementsFingerprint,
  isUserDecision,
  contractsFingerprint,
  modeSwitchReport,
  REVIEW_DECISION_ACTION,
  reviewApprovalRequest,
  reviewBatchSubject,
  reviewProgress,
  storiesFingerprint,
  storyCapabilities,
  storyPlanFingerprint,
  storyReviewProgress,
} from "./planning.js";
export type { CoverageGap, CoverageReport, GateResult, NextStep, PlanningCommand, PlanningResult, ReviewChannel } from "./planning.js";
export { RepositoryIdSchema } from "./ids.js";
export { SUPPORTED_WORKFLOW_VERSIONS } from "./workflow.js";
export { ReviewMarkSchema, StoryCapabilitySchema, STORY_CAPABILITIES } from "./story.js";
export type { ReviewMark, StoryCapability } from "./story.js";

// Standard HTML reviews and how their decisions come back.
export * from "./review-submission.js";
export { parseStrict, unknownParameters } from "./command-strict.js";
export { canonicalText } from "./human-acts.js";
export { renderReview, renderRequirementsReview, renderPrototypeReview, renderStoryPlanReview, renderStoriesReview } from "./review-html.js";
export type { RenderReviewOptions } from "./review-html.js";

// Instruction precedence, deterministic skill plan, untrusted-content handling.
export * from "./context-trust.js";

// Briefing for continuing a work item in a new chat.
export * from "./briefing.js";

// Command discovery for agents.
export { commandCatalog, explainCommandError } from "./command-catalog.js";
export type { CommandInfo } from "./command-catalog.js";

export { criterionStatus, requirementCoverage, storyCoverage, evaluateEvidence, requiredRequirements } from "./quality-model.js";
export type { CriterionState, CriterionCoverage, CoverageCounts, CoverageResult, FeatureEvaluation, Verdict } from "./quality-model.js";
export { EvidenceSourceSchema } from "./story.js";
export type { EvidenceSource } from "./story.js";
