import { z } from "zod";

/** What an approval can authorize. Shared by action plans and the approval rules in authority.ts. */
export const ApprovalOperationSchema = z.enum([
  "external_record_create",
  "external_record_update",
  "external_state_change",
  "repository_edit",
  "validation_with_side_effects",
  "git_commit",
  "git_push",
  "merge_request",
  "merge",
  "deploy",
  "release",
]);
export type ApprovalOperation = z.infer<typeof ApprovalOperationSchema>;

/** These are not covered by an implementation-plan approval. */
export const PUBLICATION_OPERATIONS = [
  "git_push",
  "merge_request",
  "merge",
  "deploy",
  "release",
] as const satisfies readonly ApprovalOperation[];

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}
