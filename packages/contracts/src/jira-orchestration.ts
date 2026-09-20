import { z } from "zod";

const ContractMeta = z.object({
  contract: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});

export const PraxisRoleSchema = z.enum(["ba", "architect", "developer", "qa"]);
export type PraxisRole = z.infer<typeof PraxisRoleSchema>;

export const RichTextInlineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("code"), text: z.string() }),
  z.object({
    type: z.literal("link"),
    href: z.string(),
    text: z.string(),
  }),
  z.object({ type: z.literal("issueRef"), key: z.string() }),
]);
export type RichTextInline = z.infer<typeof RichTextInlineSchema>;

export const RichTextBlockSchema = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("heading"),
      level: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
      ]),
      text: z.string(),
    }),
    z.object({
      type: z.literal("paragraph"),
      inlines: z.array(RichTextInlineSchema),
    }),
    z.object({
      type: z.literal("bulletList"),
      items: z.array(z.array(RichTextInlineSchema)),
    }),
    z.object({
      type: z.literal("orderedList"),
      items: z.array(z.array(RichTextInlineSchema)),
    }),
    z.object({
      type: z.literal("codeBlock"),
      language: z.string().optional(),
      text: z.string(),
    }),
    z.object({
      type: z.literal("table"),
      headers: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    }),
]);
export type RichTextBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; inlines: RichTextInline[] }
  | { type: "bulletList"; items: RichTextInline[][] }
  | { type: "orderedList"; items: RichTextInline[][] }
  | { type: "codeBlock"; language?: string; text: string }
  | { type: "table"; headers: string[]; rows: string[][] };

export const PraxisRichTextDocumentSchema = z.object({
  version: z.literal(1),
  blocks: z.array(RichTextBlockSchema),
});
export type PraxisRichTextDocument = z.infer<typeof PraxisRichTextDocumentSchema>;

export const EpicLifecycleSchema = z.enum([
  "analysis",
  "architecture",
  "development",
  "quality",
  "done",
]);
export type EpicLifecycle = z.infer<typeof EpicLifecycleSchema>;

export const TicketLifecycleSchema = z.enum([
  "ready-for-architecture",
  "ready-for-development",
  "in-progress",
  "ready-for-qa",
  "blocked",
  "done",
]);
export type TicketLifecycle = z.infer<typeof TicketLifecycleSchema>;

export const WorkPackageLifecycleSchema = z.enum([
  "ready",
  "claimed",
  "in-progress",
  "ready-for-qa",
  "blocked",
  "qa-passed",
  "done",
]);
export type WorkPackageLifecycle = z.infer<typeof WorkPackageLifecycleSchema>;

export const WorkPackageClaimSchema = z.object({
  workPackageId: z.string().min(1),
  jiraWorkPackageKey: z.string().min(1),
  actor: z.string().min(1),
  jiraAccountId: z.string().min(1),
  claimedAt: z.string().min(1),
  claimToken: z.string().min(1),
  memberIssueKeys: z.array(z.string()),
  expectedState: WorkPackageLifecycleSchema,
  state: z.enum(["active", "implementation-complete", "released"]),
});
export type WorkPackageClaim = z.infer<typeof WorkPackageClaimSchema>;

export const PraxisWorkPackageSchema = z.object({
  id: z.string().min(1),
  jiraIssueKey: z.string().min(1),
  epicKey: z.string().min(1),
  title: z.string().min(1),
  storyKeys: z.array(z.string()),
  taskKeys: z.array(z.string()),
  dependencyWorkPackages: z.array(z.string()),
  estimatedHours: z.number().nonnegative().optional(),
  architectureDecisionIds: z.array(z.string()),
  platformContractIds: z.array(z.string()),
  status: WorkPackageLifecycleSchema,
  claim: WorkPackageClaimSchema.nullable(),
});
export type PraxisWorkPackage = z.infer<typeof PraxisWorkPackageSchema>;

export const JiraBaHandoffSchema = ContractMeta.extend({
  contract: z.literal("jira.ba.architect.handoff"),
  epicKey: z.string().min(1),
  storyKeys: z.array(z.string()),
  canonicalStoryKeys: z.array(z.string()),
  supersededStoryKeys: z.array(z.string()),
  requirementIds: z.array(z.string()),
  baArtifacts: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nfrs: z.array(z.string()),
  businessRules: z.array(z.string()),
  constraints: z.array(z.string()),
  acceptanceSummary: z.string(),
  dependencies: z.array(z.string()),
  proposalReady: z.boolean(),
  readyForArchitecture: z.boolean(),
}).superRefine((h, ctx) => {
  if (h.readyForArchitecture && h.canonicalStoryKeys.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "readyForArchitecture=true requires canonicalStoryKeys.length > 0",
    });
  }
});
export type JiraBaHandoff = z.infer<typeof JiraBaHandoffSchema>;

export const JiraBaProposalStorySchema = z.object({
  logicalId: z.string().min(1),
  artifactId: z.string().min(1),
  summary: z.string().min(1),
  userStory: z.object({
    asA: z.string().min(1),
    iWant: z.string().min(1),
    soThat: z.string().min(1),
  }),
  businessContext: z.string().min(1),
  acceptanceCriteria: z
    .array(
      z.object({
        given: z.string().min(1),
        when: z.string().min(1),
        then: z.string().min(1),
      }),
    )
    .min(1),
  outOfScope: z.array(z.string()),
  dependencies: z.array(z.string()),
  requirementIds: z.array(z.string()).min(1),
});
export type JiraBaProposalStory = z.infer<typeof JiraBaProposalStorySchema>;

export const JiraBaProposalSchema = ContractMeta.extend({
  contract: z.literal("jira.ba.proposal"),
  epicKey: z.string().min(1),
  stories: z.array(JiraBaProposalStorySchema),
  nfrs: z.array(z.string()),
  businessRules: z.array(z.string()),
  openQuestions: z.array(z.string()),
});
export type JiraBaProposal = z.infer<typeof JiraBaProposalSchema>;

export const JiraWriteOpStateSchema = z.enum([
  "planned",
  "creating",
  "created",
  "verified",
  "committed",
]);
export type JiraWriteOpState = z.infer<typeof JiraWriteOpStateSchema>;

export const JiraWriteJournalEntrySchema = z.object({
  operationId: z.string().min(1),
  role: PraxisRoleSchema,
  operationType: z.string().min(1),
  artifactId: z.string().min(1),
  epicKey: z.string().optional(),
  jiraIssueKey: z.string().optional(),
  state: JiraWriteOpStateSchema,
  provider: z.enum(["cloud", "datacenter"]),
  projectKey: z.string().min(1),
  startedAt: z.string().min(1),
  completedAt: z.string().optional(),
  detail: z.string().optional(),
});
export type JiraWriteJournalEntry = z.infer<typeof JiraWriteJournalEntrySchema>;

export const JiraOperationJournalEntrySchema = z.object({
  operationId: z.string().min(1),
  artifactId: z.string().min(1),
  jiraIssueKey: z.string().optional(),
  result: z.enum(["ok", "skipped", "failed"]),
  timestamp: z.string().min(1),
  provider: z.enum(["cloud", "datacenter"]),
  kind: z.string().min(1),
  detail: z.string().optional(),
});
export type JiraOperationJournalEntry = z.infer<
  typeof JiraOperationJournalEntrySchema
>;

export const BaJiraWriteActionSchema = z.enum([
  "CREATE",
  "UPDATE",
  "UNCHANGED",
  "SUPERSEDED",
]);
export type BaJiraWriteAction = z.infer<typeof BaJiraWriteActionSchema>;

export const BaJiraWritePlanItemSchema = z.object({
  action: BaJiraWriteActionSchema,
  artifactId: z.string().min(1),
  jiraIssueKey: z.string().optional(),
  supersededBy: z.string().optional(),
  summary: z.string().optional(),
});
export type BaJiraWritePlanItem = z.infer<typeof BaJiraWritePlanItemSchema>;

export const QualityWpReportSchema = ContractMeta.extend({
  contract: z.literal("quality.work-package.report"),
  workPackageId: z.string().min(1),
  jiraWorkPackageKey: z.string().min(1),
  memberIssueResults: z.array(
    z.object({
      jiraIssueKey: z.string(),
      acceptanceCriteria: z.array(z.string()),
      coveredBy: z.array(z.string()),
      result: z.enum(["pass", "fail", "unverified"]),
    }),
  ),
  buildResult: z.enum(["pass", "fail", "skipped"]),
  testResult: z.enum(["pass", "fail", "skipped"]),
  tests: z.object({
    total: z.number(),
    pass: z.number(),
    fail: z.number(),
  }),
  coverage: z
    .object({
      lines: z.number().optional(),
      branches: z.number().optional(),
      functions: z.number().optional(),
      statements: z.number().optional(),
    })
    .nullable(),
  runtimeVerification: z.enum(["pass", "fail", "unavailable"]),
  runtimeReason: z.string().optional(),
  findings: z.array(z.unknown()),
  blockingFindings: z.array(z.unknown()),
  potentialRisks: z.array(z.string()),
  addedTests: z.array(z.string()),
  sourceChangesGuard: z.enum(["pass", "fail"]),
  overallVerdict: z.enum(["pass", "fail", "blocked"]),
  developerEvidence: z
    .object({
      workPackageId: z.string().optional(),
      jiraWorkPackageKey: z.string().optional(),
      canonicalStoryKeys: z.array(z.string()).optional(),
      requirementIds: z.array(z.string()).optional(),
      hasCompletionEvidence: z.boolean(),
      hasQualityHandoff: z.boolean(),
      readyForQuality: z.boolean().optional(),
      evidencePath: z.string().optional(),
      qualityHandoffPath: z.string().optional(),
    })
    .optional(),
});
export type QualityWpReport = z.infer<typeof QualityWpReportSchema>;
