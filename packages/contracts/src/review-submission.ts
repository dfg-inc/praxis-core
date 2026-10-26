import { z } from "zod";
import { RequirementIdSchema, StoryIdSchema } from "./ids.js";
import {
  currentFingerprint,
  prototypeFingerprint,
  requirementsFingerprint,
  storiesFingerprint,
  storyPlanFingerprint,
} from "./planning.js";
import { ScopeSchema } from "./planning-schemas.js";
import type { WorkflowState } from "./workflow.js";

/**
 * What an HTML review sends back. It is a list of the user's decisions about specific items, each bound to the revision
 * the user looked at. It is not state: nothing here is trusted until it is turned into workflow commands and applied by
 * the Runtime, and an item that changed since the page was rendered is skipped and reported, never overwritten.
 */

export const REVIEW_VIEWS = ["requirements", "prototype", "story-plan", "stories"] as const;
export const ReviewViewSchema = z.enum(REVIEW_VIEWS);
export type ReviewView = z.infer<typeof ReviewViewSchema>;

const Mark = z.enum(["pending", "accepted", "rejected"]);

const RequirementsPayload = z.object({
  requirements: z
    .array(
      z.object({
        id: RequirementIdSchema,
        revision: z.number().int().positive(),
        scope: ScopeSchema.optional(),
        scopeNote: z.string().max(2000).optional(),
        statement: z.string().min(1).max(4000).optional(),
        comment: z.string().max(4000).optional(),
        criteria: z
          .array(z.object({ id: z.string().min(1), revision: z.number().int().positive(), status: Mark.optional(), comment: z.string().max(4000).optional(), statement: z.string().min(1).max(4000).optional() }))
          .default([]),
        addCriteria: z.array(z.object({ statement: z.string().min(1).max(4000) })).default([]),
        removeCriteria: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** Accept every pending criterion of every in-scope requirement the user saw (the "accept all" button). */
  acceptAll: z.boolean().default(false),
});

const PrototypePayload = z.object({
  feedback: z.array(z.object({ target: z.string().min(1).max(200), comment: z.string().min(1).max(4000) })).default([]),
  resolve: z.array(z.string()).default([]),
  accept: z.boolean().default(false),
});

const PlanPayload = z.object({
  entries: z
    .array(
      z.object({
        id: StoryIdSchema,
        status: Mark.optional(),
        comment: z.string().max(4000).optional(),
        title: z.string().min(1).max(300).optional(),
        implementation: z.string().min(1).max(4000).optional(),
        userGets: z.string().min(1).max(4000).optional(),
        exclude: z.string().min(1).max(2000).optional(),
        restore: z.boolean().optional(),
      }),
    )
    .default([]),
  agree: z.boolean().default(false),
});

const StoriesPayload = z.object({
  items: z.array(z.object({ storyId: StoryIdSchema, revision: z.number().int().positive(), key: z.string().min(1), status: Mark, comment: z.string().max(4000).optional() })).default([]),
  stories: z
    .array(
      z.object({
        storyId: StoryIdSchema,
        revision: z.number().int().positive(),
        acceptAll: z.boolean().optional(),
        exclude: z.string().min(1).max(2000).optional(),
        restore: z.boolean().optional(),
        narrative: z.string().min(1).max(2000).optional(),
        objective: z.string().min(1).max(2000).optional(),
      }),
    )
    .default([]),
  accept: z.boolean().default(false),
});

export const ReviewSubmissionSchema = z.object({
  contract: z.literal("praxis.review.submission"),
  version: z.literal(1),
  reviewId: z.string().min(1).max(100),
  view: ReviewViewSchema,
  workItemId: z.string().min(1),
  /** Fingerprint of the artifact when the page was rendered. */
  baseFingerprint: z.string().min(1),
  submittedAt: z.string().optional(),
  requirements: RequirementsPayload.optional(),
  prototype: PrototypePayload.optional(),
  plan: PlanPayload.optional(),
  stories: StoriesPayload.optional(),
});
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

export function fingerprintFor(state: WorkflowState, view: ReviewView): string {
  switch (view) {
    case "requirements":
      return requirementsFingerprint(state);
    case "prototype":
      return prototypeFingerprint(state.prototype);
    case "story-plan":
      return storyPlanFingerprint(state.storyPlan);
    default:
      return storiesFingerprint(state);
  }
}

export type ReviewConflict = { item: string; reason: string };

export type SubmissionPlan = {
  commands: Array<Record<string, unknown>>;
  conflicts: ReviewConflict[];
  /** True when the artifact itself changed since the page was rendered (items are checked one by one). */
  stale: boolean;
  summary: string[];
};

/**
 * Turns the user's decisions into workflow commands. The commands are applied one by one by the Runtime, so a conflict in
 * one item does not discard the others, and each is subject to the reducer's own checks and gates.
 */
export function submissionToCommands(state: WorkflowState, raw: unknown): SubmissionPlan {
  const submission = ReviewSubmissionSchema.parse(raw);
  const conflicts: ReviewConflict[] = [];
  const commands: Array<Record<string, unknown>> = [];
  const summary: string[] = [];
  const stale = submission.baseFingerprint !== fingerprintFor(state, submission.view);
  if (submission.workItemId !== state.workItem.id) {
    return { commands: [], conflicts: [{ item: "work item", reason: `the review is for ${submission.workItemId}, the current work item is ${state.workItem.id}` }], stale: true, summary: [] };
  }
  const via = "html-review" as const;

  if (submission.view === "requirements" && submission.requirements) {
    const decisions: Array<Record<string, unknown>> = [];
    for (const item of submission.requirements.requirements) {
      const current = state.requirements.find((r) => r.id === item.id && r.status !== "superseded");
      if (!current) {
        conflicts.push({ item: item.id, reason: "the requirement no longer exists" });
        continue;
      }
      const textChanged = item.statement !== undefined || item.criteria.some((c) => c.statement !== undefined) || item.addCriteria.length > 0 || item.removeCriteria.length > 0 || (item.scope !== undefined && item.scope !== current.scope);
      if (current.revision !== item.revision && textChanged) {
        conflicts.push({ item: item.id, reason: `edited since the review (now revision ${current.revision}, the page showed ${item.revision}): re-open the review` });
        continue;
      }
      const acceptance: Array<Record<string, unknown>> = [];
      for (const criterion of item.criteria) {
        const live = current.acceptanceCriteria.find((c) => c.id === criterion.id);
        if (!live) {
          conflicts.push({ item: criterion.id, reason: "the criterion no longer exists" });
          continue;
        }
        if (live.revision !== criterion.revision && criterion.statement === undefined) {
          conflicts.push({ item: criterion.id, reason: `criterion changed since the review (now revision ${live.revision})` });
          continue;
        }
        acceptance.push({ id: criterion.id, ...(criterion.status ? { status: criterion.status } : {}), ...(criterion.comment !== undefined ? { comment: criterion.comment } : {}), ...(criterion.statement !== undefined ? { statement: criterion.statement } : {}) });
      }
      decisions.push({
        requirementId: item.id,
        ...(item.statement !== undefined ? { statement: item.statement } : {}),
        ...(item.scope !== undefined ? { scope: item.scope } : {}),
        ...(item.scopeNote !== undefined ? { scopeNote: item.scopeNote } : {}),
        ...(item.comment !== undefined ? { comment: item.comment } : {}),
        acceptance,
        addAcceptance: item.addCriteria,
        removeAcceptance: item.removeCriteria,
      });
    }
    if (decisions.length > 0) {
      commands.push({ action: "review-requirements", via, decisions });
      summary.push(`${decisions.length} requirement(s) with decisions`);
    }
    if (submission.requirements.acceptAll) {
      if (conflicts.length > 0 || stale) conflicts.push({ item: "accept all", reason: "not applied: part of the review is out of date, re-open it" });
      else {
        commands.push({ action: "accept-requirements", via });
        summary.push("accept all pending criteria");
      }
    }
  }

  if (submission.view === "prototype" && submission.prototype) {
    const p = submission.prototype;
    if (!state.prototype) conflicts.push({ item: "prototype", reason: "there is no prototype" });
    else {
      if (p.feedback.length > 0 || p.resolve.length > 0) {
        commands.push({ action: "prototype-feedback", via, items: p.feedback, resolve: p.resolve });
        summary.push(`${p.feedback.length} comment(s)`);
      }
      if (p.accept) {
        if (stale) conflicts.push({ item: "accept prototype", reason: "the prototype changed since the review: re-open it" });
        else {
          commands.push({ action: "accept-prototype", via });
          summary.push("prototype accepted");
        }
      }
    }
  }

  if (submission.view === "story-plan" && submission.plan) {
    const operations: Array<Record<string, unknown>> = [];
    for (const entry of submission.plan.entries) {
      const current = state.storyPlan?.entries.find((e) => e.id === entry.id);
      if (!current) {
        conflicts.push({ item: entry.id, reason: "the plan line no longer exists" });
        continue;
      }
      const patch: Record<string, unknown> = {};
      if (entry.title !== undefined && entry.title !== current.title) patch.title = entry.title;
      if (entry.implementation !== undefined && entry.implementation !== current.implementation) patch.implementation = entry.implementation;
      if (entry.userGets !== undefined && entry.userGets !== current.userGets) patch.userGets = entry.userGets;
      if (Object.keys(patch).length > 0) operations.push({ op: "update", id: entry.id, patch });
      if (entry.exclude !== undefined) operations.push({ op: "exclude", id: entry.id, reason: entry.exclude });
      if (entry.restore) operations.push({ op: "restore", id: entry.id });
      if (entry.status !== undefined) operations.push({ op: "review", id: entry.id, status: entry.status, ...(entry.comment !== undefined ? { comment: entry.comment } : {}) });
    }
    if (operations.length > 0) {
      commands.push({ action: "update-story-plan", via, operations });
      summary.push(`${operations.length} plan change(s)`);
    }
    if (submission.plan.agree) {
      if (conflicts.length > 0) conflicts.push({ item: "agree plan", reason: "not applied: part of the review could not be applied" });
      else {
        commands.push({ action: "agree-story-plan", via });
        summary.push("plan agreed");
      }
    }
  }

  if (submission.view === "stories" && submission.stories) {
    const s = submission.stories;
    for (const story of s.stories) {
      const current = state.stories.find((x) => x.id === story.storyId && x.status !== "superseded");
      if (!current) {
        conflicts.push({ item: story.storyId, reason: "the story no longer exists" });
        continue;
      }
      if (current.revision !== story.revision) {
        conflicts.push({ item: story.storyId, reason: `changed since the review (now revision ${current.revision}, the page showed ${story.revision})` });
        continue;
      }
      if (story.narrative !== undefined || story.objective !== undefined) {
        commands.push({ action: "update-story", id: story.storyId, patch: { ...(story.narrative !== undefined ? { narrative: story.narrative } : {}), ...(story.objective !== undefined ? { objective: story.objective } : {}) }, reason: "edited in the review" });
        summary.push(`${story.storyId} edited`);
        continue; // the revision moved: marks for this story would be stale, the user reviews it again
      }
      if (story.exclude !== undefined) {
        commands.push({ action: "exclude-story", id: story.storyId, reason: story.exclude });
        summary.push(`${story.storyId} excluded`);
        continue;
      }
      if (story.restore) {
        commands.push({ action: "restore-story", id: story.storyId });
        summary.push(`${story.storyId} restored`);
        continue;
      }
    }
    const edited = new Set(commands.filter((c) => c.action === "update-story" || c.action === "exclude-story" || c.action === "restore-story").map((c) => String(c.id)));
    const items = s.items.filter((item) => !edited.has(item.storyId));
    const acceptStories = s.stories.filter((x) => x.acceptAll && !edited.has(x.storyId)).map((x) => ({ storyId: x.storyId, revision: x.revision }));
    if (items.length > 0 || acceptStories.length > 0) {
      commands.push({ action: "review-stories", via, items, acceptStories });
      summary.push(`${items.length} item mark(s), ${acceptStories.length} bulk accept(s)`);
    }
    if (s.accept) {
      if (conflicts.length > 0 || edited.size > 0) conflicts.push({ item: "accept stories", reason: "not applied: stories changed or could not be applied, review them again" });
      else {
        commands.push({ action: "accept-stories", via });
        summary.push("stories accepted");
      }
    }
  }

  return { commands, conflicts, stale, summary };
}

export { currentFingerprint };
