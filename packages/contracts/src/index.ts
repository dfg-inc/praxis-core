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
});
export type DeveloperToQualityHandoff = z.infer<
  typeof DeveloperToQualityHandoffSchema
>;

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
