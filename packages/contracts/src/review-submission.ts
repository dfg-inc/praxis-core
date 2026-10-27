import { z } from "zod";
import { RequirementIdSchema, StoryIdSchema } from "./ids.js";
import {
  contractsFingerprint,
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

export const REVIEW_VIEWS = ["requirements", "prototype", "story-plan", "stories", "contracts"] as const;
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
          .array(z.object({ id: z.string().min(1), revision: z.number().int().positive(), from: Mark.optional(), fromComment: z.string().max(4000).optional(), status: Mark.optional(), comment: z.string().max(4000).optional(), statement: z.string().min(1).max(4000).optional() }))
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
  items: z.array(z.object({ storyId: StoryIdSchema, revision: z.number().int().positive(), key: z.string().min(1), from: Mark.optional(), status: Mark, comment: z.string().max(4000).optional() })).default([]),
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
  /** Contracts the user agrees. Implementation across services waits for it; an agent can propose a contract, never agree it. */
  contracts: z.object({ agree: z.array(z.string().min(1)).default([]), remove: z.array(z.string().min(1)).default([]) }).optional(),
  /** Leaving guided mode switches the gates off, so it is the user's call. */
  modeChange: z.object({ to: z.enum(["classic", "guided"]), reason: z.string().max(1000).optional() }).optional(),
  /** Gaps the user chooses not to cover (a prototype for a pure refactor, a capability a requirement does not need). Only the user may waive. */
  waivers: z.array(z.object({ kind: z.string().min(1).max(100), requirementId: RequirementIdSchema.optional(), reason: z.string().min(3).max(1000) })).default([]),
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
    case "contracts":
      return contractsFingerprint(state);
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
  /** One line per decision, as the user would read it: what an approval dialog shows. */
  details: string[];
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
  const details: string[] = [];
  const stale = submission.baseFingerprint !== fingerprintFor(state, submission.view);
  if (submission.workItemId !== state.workItem.id) {
    return { commands: [], conflicts: [{ item: "work item", reason: `the review is for ${submission.workItemId}, the current work item is ${state.workItem.id}` }], stale: true, summary: [], details: [] };
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
        if (live.revision !== criterion.revision) {
          conflicts.push({ item: criterion.id, reason: `criterion changed since you opened this page (now revision ${live.revision}, the page showed ${criterion.revision}): reload the page; your edit to it was not saved` });
          continue;
        }
        if (criterion.fromComment !== undefined && criterion.comment !== undefined && (live.review.comment ?? "") !== criterion.fromComment) {
          conflicts.push({ item: criterion.id, reason: `the remark changed since you opened this page (now "${(live.review.comment ?? "").slice(0, 120)}"): reload the page; your remark was not saved` });
          continue;
        }
        if (criterion.from !== undefined && criterion.status !== undefined && live.review.status !== criterion.from) {
          conflicts.push({ item: criterion.id, reason: `already marked ${live.review.status} since you opened this page (the page showed ${criterion.from}): reload the page; your decision was not saved` });
          continue;
        }
        const unchanged = (criterion.status === undefined || criterion.status === live.review.status) && (criterion.comment === undefined || criterion.comment === (live.review.comment ?? "")) && (criterion.statement === undefined || criterion.statement === live.statement);
        if (unchanged) continue;
        details.push(`${criterion.id} '${live.statement.slice(0, 400)}': ${[criterion.status ? criterion.status.toUpperCase() : "", criterion.statement !== undefined ? `edit to '${criterion.statement.slice(0, 400)}'` : "", criterion.comment !== undefined && criterion.comment !== (live.review.comment ?? "") ? (criterion.comment ? `comment '${criterion.comment.slice(0, 400)}'` : "clear the comment") + (live.review.comment ? ` (now '${live.review.comment.slice(0, 200)}')` : "") : ""].filter(Boolean).join(", ")}`);
        acceptance.push({ id: criterion.id, ...(criterion.status ? { status: criterion.status } : {}), ...(criterion.comment !== undefined ? { comment: criterion.comment } : {}), ...(criterion.statement !== undefined ? { statement: criterion.statement } : {}) });
      }
      if (item.statement !== undefined) details.push(`${item.id}: edit statement '${current.statement.slice(0, 60)}' -> '${item.statement.slice(0, 400)}'`);
      if (item.comment) details.push(`${item.id}: comment '${item.comment.slice(0, 400)}'`);
      if (item.scopeNote !== undefined && item.scopeNote !== (current.scopeNote ?? "")) details.push(`${item.id}: scope note '${item.scopeNote.slice(0, 400)}'`);
      if (item.scope !== undefined && item.scope !== current.scope) details.push(`${item.id}: scope ${current.scope} -> ${item.scope}`);
      for (const a of item.addCriteria) details.push(`${item.id}: add criterion '${a.statement.slice(0, 400)}'`);
      for (const r of item.removeCriteria) details.push(`${item.id}: remove criterion ${r}`);
      if (acceptance.length === 0 && item.statement === undefined && item.scope === undefined && item.scopeNote === undefined && item.comment === undefined && item.addCriteria.length === 0 && item.removeCriteria.length === 0) continue;
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
        details.push("ACCEPT every criterion still undecided and record the requirements review as accepted");
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
        for (const f of p.feedback) details.push(`prototype comment on ${f.target}: '${f.comment.slice(0, 400)}'`);
        for (const r of p.resolve) details.push(`prototype feedback ${r} resolved`);
      }
      if (p.accept) {
        if (stale) conflicts.push({ item: "accept prototype", reason: "the prototype changed since the review: re-open it" });
        else {
          commands.push({ action: "accept-prototype", via });
          summary.push("prototype accepted");
          details.push(`ACCEPT prototype revision ${state.prototype.revision}`);
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
      if (entry.exclude !== undefined) details.push(`${entry.id}: exclude (${entry.exclude})`);
      if (entry.restore) details.push(`${entry.id}: restore`);
      if (Object.keys(patch).length > 0) details.push(`${entry.id}: edit ${Object.keys(patch).join(", ")}`);
      if (entry.status !== undefined) details.push(`${entry.id} '${current.title}': ${entry.status.toUpperCase()}`);
      if (entry.status !== undefined) operations.push({ op: "review", id: entry.id, status: entry.status, ...(entry.comment !== undefined ? { comment: entry.comment } : {}) });
    }
    if (operations.length > 0) {
      commands.push({ action: "update-story-plan", via, operations });
      summary.push(`${operations.length} plan change(s)`);
    }
    if (submission.plan.agree) {
      if (conflicts.length > 0 || stale) conflicts.push({ item: "agree plan", reason: "not applied: part of the review is out of date or could not be applied; re-open it" });
      else {
        commands.push({ action: "agree-story-plan", via });
        summary.push("plan agreed");
        details.push(`AGREE the story plan (${state.storyPlan?.entries.length ?? 0} lines, revision ${state.storyPlan?.revision})`);
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
    const items = s.items.filter((item) => {
      if (edited.has(item.storyId)) return false;
      const live = state.stories.find((x) => x.id === item.storyId && x.status !== "superseded");
      const current = live?.review[item.key]?.status ?? "pending";
      if (item.from !== undefined && current !== item.from) {
        conflicts.push({ item: `${item.storyId} ${item.key}`, reason: `already marked ${current} by someone else since the review (the page showed ${item.from})` });
        return false;
      }
      if (current === item.status && (item.comment === undefined || item.comment === (live?.review[item.key]?.comment ?? ""))) return false;
      details.push(`${item.storyId} ${item.key}: ${item.status.toUpperCase()}${item.comment ? ` ('${item.comment.slice(0, 400)}')` : ""}`);
      return true;
    });
    const acceptStories = s.stories.filter((x) => x.acceptAll && !edited.has(x.storyId)).map((x) => ({ storyId: x.storyId, revision: x.revision }));
    for (const a of acceptStories) details.push(`${a.storyId}: ACCEPT everything in the story (revision ${a.revision})`);
    if (items.length > 0 || acceptStories.length > 0) {
      commands.push({ action: "review-stories", via, items: items.map(({ from: _from, ...rest }) => rest), acceptStories });
      summary.push(`${items.length} item mark(s), ${acceptStories.length} bulk accept(s)`);
    }
    if (s.accept) {
      if (conflicts.length > 0 || edited.size > 0 || stale) conflicts.push({ item: "accept stories", reason: "not applied: stories changed or could not be applied, review them again" });
      else {
        commands.push({ action: "accept-stories", via });
        summary.push("stories accepted");
        details.push("ACCEPT the stories");
      }
    }
  }

  if (submission.view === "contracts" && submission.contracts) {
    for (const id of submission.contracts.agree) {
      const contract = state.contracts.find((c) => c.id === id);
      if (!contract) {
        conflicts.push({ item: id, reason: "the contract no longer exists" });
        continue;
      }
      if (stale) {
        conflicts.push({ item: id, reason: "the contracts changed since the page was rendered: re-open it so you agree what is there now" });
        continue;
      }
      if (contract.status === "agreed") continue;
      const { status: _s, agreement: _a, ...content } = contract;
      commands.push({ action: "set-contract", via, contract: { ...content, status: "agreed" } });
      summary.push(`contract ${id} agreed`);
      details.push(`AGREE contract ${id} '${contract.name}': provider ${contract.providerServiceId}, consumers ${contract.consumerServiceIds.join(", ") || "none"}${contract.schemaRef ? `, schema ${contract.schemaRef}` : ""}${contract.description ? `, description '${contract.description.slice(0, 400)}'` : ""}${contract.requirementIds.length ? `, requirements ${contract.requirementIds.join(" ")}` : ""}${contract.storyIds.length ? `, stories ${contract.storyIds.join(" ")}` : ""}`);
    }
  }
  if (submission.view === "contracts" && submission.contracts) {
    for (const id of submission.contracts.remove) {
      const contract = state.contracts.find((c) => c.id === id);
      if (!contract) {
        conflicts.push({ item: id, reason: "the contract no longer exists" });
        continue;
      }
      commands.push({ action: "remove-contract", via, id });
      summary.push(`contract ${id} removed`);
      details.push(`REMOVE contract ${id} '${contract.name}' (${contract.status})`);
    }
  }
  if (submission.modeChange && submission.modeChange.to !== state.mode) {
    commands.push({ action: "set-mode", via, mode: submission.modeChange.to, ...(submission.modeChange.reason ? { reason: submission.modeChange.reason } : {}) });
    summary.push(`mode -> ${submission.modeChange.to}`);
    details.push(`SWITCH this work item from ${state.mode} to ${submission.modeChange.to}${submission.modeChange.to === "classic" ? ": stage gates, plan-before-stories and coverage checks stop being enforced (nothing is deleted)" : ""}`);
  }
  for (const w of submission.waivers) {
    commands.push({ action: "waive-coverage", kind: w.kind, ...(w.requirementId ? { requirementId: w.requirementId } : {}), reason: w.reason });
    summary.push(`waive ${w.kind}`);
    details.push(`WAIVE ${w.kind}${w.requirementId ? ` for ${w.requirementId}` : ""}: '${w.reason.slice(0, 400)}'`);
  }
  return { commands, conflicts, stale, summary, details };
}

export { currentFingerprint };
