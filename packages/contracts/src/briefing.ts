import { analyzeStoryCoverage, acceptanceStatus, nextStep, reviewProgress, storyReviewProgress, type NextStep } from "./planning.js";
import type { WorkflowState } from "./workflow.js";

/**
 * What a new chat needs to continue a work item. Built only from Praxis records, so it never claims to restore the earlier
 * conversation: the decisions, open questions and next action are what survive.
 */
export type ResumeBriefing = {
  workItem: { id: string; title: string; kind: string; mode: string; request: string };
  phase: string;
  next: NextStep;
  progress: {
    requirements: ReturnType<typeof reviewProgress>;
    prototype: { exists: boolean; kind?: string; revision?: number; acceptance: string; openFeedback: number };
    storyPlan: { exists: boolean; revision?: number; entries: number; detailed: number; acceptance: string };
    stories: ReturnType<typeof storyReviewProgress> & { acceptance: string; coverageOk: boolean };
    services: Array<{ id: string; status: string; repositoryId?: string }>;
  };
  decisions: Array<{ id: string; statement: string; confirmed: boolean }>;
  assumptions: string[];
  openQuestions: string[];
  risks: string[];
  blockers: string[];
  repositories: Array<{ id: string; name: string; role: string; inspected: boolean; localPath?: string }>;
  lastSessions: Array<{ at: string; role?: string; summary: string; nextAction?: string }>;
  restoredFrom: string;
  notRestored: string;
};

export function buildResumeBriefing(state: WorkflowState): ResumeBriefing {
  const coverage = analyzeStoryCoverage(state);
  return {
    workItem: { id: state.workItem.id, title: state.workItem.title, kind: state.workItem.kind ?? "feature", mode: state.mode, request: state.history[0]?.note ?? "" },
    phase: state.phase,
    next: nextStep(state),
    progress: {
      requirements: reviewProgress(state),
      prototype: {
        exists: Boolean(state.prototype),
        kind: state.prototype?.kind,
        revision: state.prototype?.revision,
        acceptance: acceptanceStatus(state, "prototype"),
        openFeedback: state.prototype?.feedback.filter((f) => !f.resolved).length ?? 0,
      },
      storyPlan: {
        exists: Boolean(state.storyPlan),
        revision: state.storyPlan?.revision,
        entries: state.storyPlan?.entries.length ?? 0,
        detailed: state.storyPlan?.entries.filter((e) => e.status === "detailed").length ?? 0,
        acceptance: acceptanceStatus(state, "story_plan"),
      },
      stories: { ...storyReviewProgress(state), acceptance: acceptanceStatus(state, "stories_review"), coverageOk: coverage.ok },
      services: state.services.map((s) => ({ id: s.id, status: s.status, repositoryId: s.repositoryId })),
    },
    decisions: state.decisions.map((d) => ({ id: d.id, statement: d.statement, confirmed: d.confirmed })),
    assumptions: state.assumptions.map((a) => `${a.id}: ${a.statement}`),
    openQuestions: state.openQuestions,
    risks: state.risks,
    blockers: state.blockers,
    repositories: state.repositories.map((r) => ({ id: r.id, name: r.name, role: r.role, inspected: Boolean(r.inspection), localPath: r.localPath })),
    lastSessions: state.sessionLog.slice(-5),
    restoredFrom: "Praxis workflow state (requirements, stories, decisions, review marks, prototype, plan, repositories, session notes).",
    notRestored: "The earlier chat messages. Only what was recorded in Praxis is available; anything that was only said in chat has to be repeated.",
  };
}
