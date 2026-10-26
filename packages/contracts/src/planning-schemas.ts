import { z } from "zod";
import { RepositoryIdSchema, RequirementIdSchema, StoryIdSchema } from "./ids.js";
import { ReviewMarkSchema, StoryCapabilitySchema } from "./story.js";

/**
 * Planning contracts: the stages a user works through (request to delivery), scope and review of requirements, the
 * prototype, the story plan, registered repositories, cross-service contracts, change impact and the session log.
 * They extend the workflow state; they are not a second store. The HTML reviews are derived views of this state.
 */

// --- the user's pipeline ---------------------------------------------------------------------------------------

export const PHASES = [
  "request",
  "discovery",
  "requirements",
  "requirements_review",
  "prototype",
  "story_plan",
  "stories_review",
  "architecture",
  "development",
  "quality",
  "delivery",
] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

/** Phases a user accepts explicitly. Acceptance is recorded against the revision that was reviewed. */
export const ACCEPTABLE_PHASES = ["requirements_review", "prototype", "story_plan", "stories_review"] as const;
export const AcceptablePhaseSchema = z.enum(ACCEPTABLE_PHASES);
export type AcceptablePhase = z.infer<typeof AcceptablePhaseSchema>;

export const PhaseAcceptanceSchema = z.object({
  /** What was accepted: the revision of the reviewed artifact at the time. */
  revision: z.number().int().nonnegative(),
  at: z.string(),
  via: z.enum(["html-review", "approved", "chat", "system"]).default("chat"),
  /** Content fingerprint of what was accepted. The acceptance counts only while the artifact still has it. */
  fingerprint: z.string().optional(),
});
export type PhaseAcceptance = z.infer<typeof PhaseAcceptanceSchema>;

export const PhaseHistoryEntrySchema = z.object({
  at: z.string(),
  kind: z.enum(["advance", "return"]),
  from: PhaseSchema,
  to: PhaseSchema,
  reason: z.string().default(""),
  /** Artifacts whose acceptance was invalidated by a return. */
  invalidated: z.array(z.string()).default([]),
});
export type PhaseHistoryEntry = z.infer<typeof PhaseHistoryEntrySchema>;

export const ScopeSchema = z.enum(["in", "deferred", "excluded"]);
export type Scope = z.infer<typeof ScopeSchema>;

export const WorkItemKindSchema = z.enum(["feature", "change", "extension", "fix", "technical"]);
export type WorkItemKind = z.infer<typeof WorkItemKindSchema>;

export const WorkflowModeSchema = z.enum(["classic", "guided"]);
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;

// --- repositories and cross-service contracts --------------------------------------------------------------------

export const RepositoryInspectionSchema = z.object({
  at: z.string(),
  /** Read from the repository by the Runtime, never typed in by an agent. */
  headSha: z.string().optional(),
  branch: z.string().optional(),
  summary: z.string(),
  frameworks: z.array(z.string()).default([]),
  /** Agent-instruction files found (CLAUDE.md, AGENTS.md, skills, rules). Listed, never followed. */
  instructionFiles: z.array(z.string()).default([]),
  /** Paths the inspection actually looked at. */
  entries: z.array(z.object({ path: z.string(), note: z.string().optional() })).default([]),
  frontend: z
    .object({
      hasStyles: z.boolean(),
      styleFiles: z.array(z.string()).default([]),
      componentDirs: z.array(z.string()).default([]),
    })
    .optional(),
});
export type RepositoryInspection = z.infer<typeof RepositoryInspectionSchema>;

export const RepositorySchema = z.object({
  id: RepositoryIdSchema,
  name: z.string().min(1),
  /** Free text: "web frontend", "iOS app", "billing API". Any number of repositories, any roles. */
  role: z.string().default(""),
  localPath: z.string().optional(),
  remoteUrl: z.string().optional(),
  branch: z.string().optional(),
  notes: z.string().optional(),
  registeredAt: z.string(),
  status: z.enum(["registered", "inspected"]).default("registered"),
  inspection: RepositoryInspectionSchema.optional(),
});
export type Repository = z.infer<typeof RepositorySchema>;

export const ServiceContractSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  providerServiceId: z.string().min(1),
  consumerServiceIds: z.array(z.string()).default([]),
  description: z.string().default(""),
  /** Where the schema/endpoint definition lives, for example "openapi.yaml#/paths/~1orders". */
  schemaRef: z.string().optional(),
  requirementIds: z.array(RequirementIdSchema).default([]),
  storyIds: z.array(StoryIdSchema).default([]),
  status: z.enum(["proposed", "agreed"]).default("proposed"),
});
export type ServiceContract = z.infer<typeof ServiceContractSchema>;

// --- change requests -------------------------------------------------------------------------------------------

export const EvidenceRefSchema = z.object({
  repositoryId: RepositoryIdSchema,
  path: z.string().min(1),
  note: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ImpactSchema = z.object({
  revision: z.number().int().positive(),
  recordedAt: z.string(),
  baseline: z.object({
    summary: z.string().min(1),
    /** Behaviour that exists today and must keep working unless the change says otherwise. */
    behaviors: z
      .array(z.object({ id: z.string().min(1), statement: z.string().min(1), evidence: z.array(EvidenceRefSchema).default([]) }))
      .default([]),
  }),
  affected: z
    .array(
      z.object({
        repositoryId: RepositoryIdSchema,
        path: z.string().optional(),
        area: z.string().min(1),
        change: z.string().min(1),
        risk: z.string().optional(),
      }),
    )
    .default([]),
  regressionChecks: z
    .array(
      z.object({
        id: z.string().min(1),
        statement: z.string().min(1),
        requirementIds: z.array(RequirementIdSchema).default([]),
        serviceId: z.string().optional(),
      }),
    )
    .default([]),
});
export type Impact = z.infer<typeof ImpactSchema>;

// --- prototype --------------------------------------------------------------------------------------------------

export const PrototypeStateSchema = z.enum(["default", "loading", "empty", "error", "success", "denied"]);
export type PrototypeState = z.infer<typeof PrototypeStateSchema>;

export const ELEMENT_KINDS = [
  "heading",
  "text",
  "table",
  "list",
  "form",
  "field",
  "button",
  "link",
  "filter",
  "search",
  "tabs",
  "badge",
  "modal",
  "message",
] as const;
export const ElementKindSchema = z.enum(ELEMENT_KINDS);

export const PrototypeElementSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
  kind: ElementKindSchema,
  label: z.string().default(""),
  /** What using this element means: lets coverage see view/search/create/edit/delete/permissions. */
  intent: StoryCapabilitySchema.optional(),
  /** table/list: mock collection shown. form/field: collection edited. */
  collection: z.string().optional(),
  /** field: the collection field it edits. table/list: columns (field keys) to show. */
  field: z.string().optional(),
  columns: z.array(z.string()).default([]),
  /** button/link: screen it opens. */
  navigatesTo: z.string().optional(),
  /** button: what it does to the mock data. */
  action: z.enum(["navigate", "add-row", "edit-row", "delete-row", "submit", "open-modal", "close-modal", "none"]).optional(),
  /** Roles that may use the element; others see the "denied" state. Empty means everyone. */
  allowedRoles: z.array(z.string()).default([]),
  text: z.string().optional(),
  requirementIds: z.array(RequirementIdSchema).default([]),
  acIds: z.array(z.string()).default([]),
});
export type PrototypeElement = z.infer<typeof PrototypeElementSchema>;

export const PrototypeScreenSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
  title: z.string().min(1),
  description: z.string().default(""),
  /** Which states the screen shows. The reviewer can switch between them. */
  states: z.array(PrototypeStateSchema).default(["default"]),
  elements: z.array(PrototypeElementSchema).default([]),
  /** Text shown in states other than default, per state. */
  stateMessages: z.record(z.string(), z.string()).default({}),
});
export type PrototypeScreen = z.infer<typeof PrototypeScreenSchema>;

export const MockFieldSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  label: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "date", "enum"]).default("string"),
  options: z.array(z.string()).optional(),
});

export const MockCollectionSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
  name: z.string().min(1),
  fields: z.array(MockFieldSchema).min(1),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(200).default([]),
});
export type MockCollection = z.infer<typeof MockCollectionSchema>;

export const ApiEndpointSchema = z.object({
  id: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  summary: z.string().default(""),
  auth: z.string().optional(),
  requirementIds: z.array(RequirementIdSchema).default([]),
  acIds: z.array(z.string()).default([]),
  request: z.unknown().optional(),
  responses: z
    .array(z.object({ status: z.number().int(), description: z.string().default(""), example: z.unknown().optional() }))
    .default([]),
});
export type ApiEndpoint = z.infer<typeof ApiEndpointSchema>;

export const PrototypeTokensSchema = z.object({
  colors: z.record(z.string(), z.string()).default({}),
  fonts: z.record(z.string(), z.string()).default({}),
  radius: z.string().optional(),
  spacing: z.string().optional(),
  /** Files the styles were read from. Empty means neutral defaults were used and the prototype says so. */
  sources: z.array(z.object({ repositoryId: z.string().optional(), file: z.string(), note: z.string().optional() })).default([]),
});
export type PrototypeTokens = z.infer<typeof PrototypeTokensSchema>;

export const PrototypeFeedbackSchema = z.object({
  id: z.string().min(1),
  target: z.string().min(1),
  comment: z.string().min(1),
  at: z.string(),
  resolved: z.boolean().default(false),
});
export type PrototypeFeedback = z.infer<typeof PrototypeFeedbackSchema>;

export const PrototypeSchema = z.object({
  id: z.string().min(1).default("PROTO-1"),
  /** "ui" shows screens on mock data. "api" is a technical prototype: endpoints with request/response examples. */
  kind: z.enum(["ui", "api"]),
  title: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.enum(["draft", "accepted"]).default("draft"),
  notes: z.string().default(""),
  styles: PrototypeTokensSchema.default({ colors: {}, fonts: {}, sources: [] }),
  screens: z.array(PrototypeScreenSchema).default([]),
  startScreen: z.string().optional(),
  mock: z.array(MockCollectionSchema).default([]),
  endpoints: z.array(ApiEndpointSchema).default([]),
  roles: z.array(z.string()).default([]),
  feedback: z.array(PrototypeFeedbackSchema).default([]),
  history: z.array(z.object({ revision: z.number().int().positive(), at: z.string(), summary: z.string() })).default([]),
});
export type Prototype = z.infer<typeof PrototypeSchema>;

// --- story plan -------------------------------------------------------------------------------------------------

export const StoryPlanEntrySchema = z.object({
  id: StoryIdSchema,
  title: z.string().min(1),
  /** What will be implemented. */
  implementation: z.string().min(1),
  /** What the user gets. */
  userGets: z.string().min(1),
  /** Data that appears or changes. */
  data: z.array(z.string()).default([]),
  /** Prototype screens/elements covered ("screen", "screen#element"). */
  screenRefs: z.array(z.string()).default([]),
  requirementIds: z.array(RequirementIdSchema).min(1),
  acIds: z.array(z.string()).default([]),
  repositoryIds: z.array(z.string()).default([]),
  serviceIds: z.array(z.string()).default([]),
  dependsOn: z.array(StoryIdSchema).default([]),
  capabilities: z.array(StoryCapabilitySchema).default([]),
  status: z.enum(["planned", "detailed", "excluded"]).default("planned"),
  excludedReason: z.string().optional(),
  /** User's review of this plan line. */
  review: ReviewMarkSchema.default({ status: "pending" }),
});
export type StoryPlanEntry = z.infer<typeof StoryPlanEntrySchema>;

export const StoryPlanSchema = z.object({
  revision: z.number().int().positive(),
  status: z.enum(["draft", "agreed"]).default("draft"),
  entries: z.array(StoryPlanEntrySchema).default([]),
  history: z.array(z.object({ revision: z.number().int().positive(), at: z.string(), summary: z.string() })).default([]),
});
export type StoryPlan = z.infer<typeof StoryPlanSchema>;

// --- history and session ---------------------------------------------------------------------------------------

export const StoryHistoryEntrySchema = z.object({
  storyId: StoryIdSchema,
  /** The revision this snapshot is OF (the one that was replaced). */
  revision: z.number().int().positive(),
  at: z.string(),
  kind: z.enum(["edit", "exclude", "restore", "split", "merge", "scope", "requirement-change"]),
  summary: z.string(),
  /** Compact snapshot of what changed hands: narrative and acceptance criteria. */
  previous: z.object({
    narrative: z.string(),
    objective: z.string(),
    acceptanceCriteria: z.array(z.object({ id: z.string(), given: z.string(), when: z.string(), then: z.string() })),
    status: z.string(),
    confirmedBehavior: z.boolean(),
  }),
});
export type StoryHistoryEntry = z.infer<typeof StoryHistoryEntrySchema>;

export const SessionNoteSchema = z.object({
  at: z.string(),
  role: z.string().optional(),
  summary: z.string().min(1),
  nextAction: z.string().optional(),
});
export type SessionNote = z.infer<typeof SessionNoteSchema>;

export const CoverageWaiverSchema = z.object({
  id: z.string().min(1),
  /** A capability ("view", "permissions", ...) or "requirement-without-story". */
  kind: z.string().min(1),
  requirementId: RequirementIdSchema.optional(),
  reason: z.string().min(1),
  at: z.string(),
});
export type CoverageWaiver = z.infer<typeof CoverageWaiverSchema>;

/** Fields added to the workflow state in contract 1.1.0. All have defaults, so a 1.0.0 state loads unchanged. */
export const PlanningStateFields = {
  mode: WorkflowModeSchema.default("classic"),
  phase: PhaseSchema.default("request"),
  phaseAcceptance: z.record(z.string(), PhaseAcceptanceSchema).default({}),
  phaseHistory: z.array(PhaseHistoryEntrySchema).default([]),
  repositories: z.array(RepositorySchema).default([]),
  contracts: z.array(ServiceContractSchema).default([]),
  impact: ImpactSchema.optional(),
  prototype: PrototypeSchema.optional(),
  storyPlan: StoryPlanSchema.optional(),
  storyHistory: z.array(StoryHistoryEntrySchema).default([]),
  sessionLog: z.array(SessionNoteSchema).default([]),
  waivers: z.array(CoverageWaiverSchema).default([]),
  updatedAt: z.string().optional(),
};
