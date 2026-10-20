import { z } from "zod";

const RequirementIdSchema = z
  .string()
  .regex(/^(REQ-[A-Z][A-Z0-9]*-\d{3,}|[A-Z][A-Z0-9]*-(?:FR|NFR|BR)\d+)$/);

export const StoryIdSchema = z.string().regex(/^US-[A-Z][A-Z0-9]*-\d{3,}$/);
export type StoryId = z.infer<typeof StoryIdSchema>;

export const STORY_NARRATIVE =
  /^As a [^,]+, I want [^,]+, so that .+/i;

export const CoverageStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "PASS_WITH_RISKS",
  "BLOCKED",
  "NOT_VERIFIED",
]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

export const StoryCriterionSchema = z.object({
  id: z.string().min(1),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
});

export const UserStorySchema = z.object({
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
  acceptanceCriteria: z.array(StoryCriterionSchema).min(1),
  expectedResults: z.array(z.string()).min(1),
  dependencies: z.array(z.string()).default([]),
  assumptionIds: z.array(z.string()).default([]),
  unresolvedDecisionIds: z.array(z.string()).default([]),
  serviceIds: z.array(z.string()).default([]),
  revision: z.number().int().positive(),
  status: z.enum(["proposed", "confirmed", "superseded"]),
  confirmedBehavior: z.boolean(),
  stale: z.boolean().default(false),
});
export type UserStory = z.infer<typeof UserStorySchema>;

export const CoverageEntrySchema = z.object({
  storyId: StoryIdSchema,
  /** Story revision this scenario verified. Older revisions are not evidence for the current one. */
  storyRevision: z.number().int().positive().optional(),
  requirementId: RequirementIdSchema,
  acceptanceCriterionId: z.string().min(1),
  scenarioId: z.string().min(1),
  kind: z.enum(["happy", "alternative", "negative", "edge", "contract", "security"]),
  serviceId: z.string().min(1),
  repository: z.string().default(""),
  implementationPath: z.string().default(""),
  testRef: z.string().default(""),
  evidence: z.array(z.string()).default([]),
  findingId: z.string().optional(),
  status: CoverageStatusSchema,
  critical: z.boolean().default(false),
});
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

export const ChangeRecordSchema = z.object({
  id: z.string().min(1),
  findingId: z.string().min(1),
  storyIds: z.array(StoryIdSchema).default([]),
  requirementIds: z.array(RequirementIdSchema).default([]),
  serviceId: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  baseSha: z.string().min(1),
  commitSha: z.string().min(1),
  files: z.array(z.string()).default([]),
  remote: z.string().optional(),
  changeRequest: z.string().optional(),
  mrStatus: z.enum(["opened", "blocked", "not_requested"]),
  authorRole: z.literal("quality"),
});
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

export function assertStoryNarrative(narrative: string): void {
  if (!STORY_NARRATIVE.test(narrative.trim())) {
    throw new Error(
      "STORY_NARRATIVE: use 'As a [role], I want [capability], so that [business value].'",
    );
  }
}

export function missingRepositoryPrompts(input: {
  services: Array<{ id: string; name?: string; localPath?: string; remoteUrl?: string }>;
  requiredServiceIds: string[];
}): Array<{ id: string; prompt: string }> {
  const byId = new Map(input.services.map((service) => [service.id, service]));
  const prompts = [];
  for (const id of input.requiredServiceIds) {
    const service = byId.get(id);
    if (service?.localPath || service?.remoteUrl) continue;
    const name = service?.name ?? id;
    prompts.push({
      id: `Q-REPO-${id.toUpperCase()}`,
      prompt: `This feature affects ${name}. I need the local path or repository URL for ${id} to complete end-to-end verification.`,
    });
  }
  return prompts;
}

/** Scenario status is not the final verdict. Critical gaps cannot become PASS. */
export function rollupStoryVerdict(entries: CoverageEntry[]): {
  verdict: "PASS" | "PASS_WITH_RISKS" | "FAIL";
  reasons: string[];
} {
  if (entries.length === 0) {
    return { verdict: "FAIL", reasons: ["no story scenarios were verified"] };
  }
  const reasons: string[] = [];
  for (const entry of entries) {
    if (entry.status === "FAIL") reasons.push(`${entry.scenarioId} FAIL`);
    if ((entry.status === "NOT_VERIFIED" || entry.status === "BLOCKED") && entry.critical) {
      reasons.push(`${entry.scenarioId} ${entry.status}`);
    }
  }
  if (reasons.length) return { verdict: "FAIL", reasons };
  const risks = entries.filter(
    (entry) =>
      entry.status === "PASS_WITH_RISKS" ||
      entry.status === "NOT_VERIFIED" ||
      entry.status === "BLOCKED",
  );
  if (risks.length) {
    return {
      verdict: "PASS_WITH_RISKS",
      reasons: risks.map((entry) => `${entry.scenarioId} ${entry.status}`),
    };
  }
  return { verdict: "PASS", reasons: [] };
}
