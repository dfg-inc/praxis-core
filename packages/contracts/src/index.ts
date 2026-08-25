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
      readyForDev: z.boolean(),
    }),
  ),
});
export type ArchitectToDeveloperHandoff = z.infer<
  typeof ArchitectToDeveloperHandoffSchema
>;

/** Developer → Quality: merge request intent. */
export const DeveloperToQualityHandoffSchema = ContractMetaSchema.extend({
  contract: z.literal("developer.quality.handoff"),
  mergeRequestRef: z.string().min(1),
  intention: z.string().min(1),
  requirementIds: z.array(z.string()),
  decisionIds: z.array(z.string()),
  verification: z.object({
    build: z.boolean(),
    tests: z.boolean(),
    lint: z.boolean(),
    packageCriteria: z.boolean(),
  }),
  /** Optional machine AC checks Quality can execute against the product tree. */
  acceptanceChecks: z
    .array(
      z.object({
        file: z.string().min(1),
        contains: z.string().min(1),
      }),
    )
    .optional(),
});
export type DeveloperToQualityHandoff = z.infer<
  typeof DeveloperToQualityHandoffSchema
>;

export function parseContract<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> {
  return schema.parse(data);
}
