import { z } from "zod";

/** Stable identifiers shared by the workflow, planning and story contracts. They never change once issued. */
export const RequirementIdSchema = z
  .string()
  .regex(/^(REQ-[A-Z][A-Z0-9]*-\d{3,}|[A-Z][A-Z0-9]*-(?:FR|NFR|BR)\d+)$/);

export const StoryIdSchema = z.string().regex(/^US-[A-Z][A-Z0-9]*-\d{3,}$/);
export type StoryId = z.infer<typeof StoryIdSchema>;

/** A registered repository: a short, stable slug chosen at registration. */
export const RepositoryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/);
export type RepositoryId = z.infer<typeof RepositoryIdSchema>;
