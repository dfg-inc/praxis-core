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

// --- repositories: one work item across any number of them ------------------------------------------------------------

/** Services in an order where every service comes after the ones it depends on. Services in a cycle are reported, not ordered. */
export function implementationOrder(state: WorkflowState): { order: string[]; cycle: string[] } {
  const ids = state.services.map((s) => s.id);
  const deps = new Map(state.services.map((s) => [s.id, s.dependsOn.filter((d) => ids.includes(d))]));
  const order: string[] = [];
  const done = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of ids) {
      if (done.has(id)) continue;
      if ((deps.get(id) ?? []).every((d) => done.has(d))) {
        order.push(id);
        done.add(id);
        progressed = true;
      }
    }
  }
  return { order, cycle: ids.filter((id) => !done.has(id)) };
}

export type RepositoryProgress = {
  repositoryId: string;
  name: string;
  role: string;
  stories: string[];
  requirements: string[];
  services: string[];
  /** A current implementation record exists for at least one service here: somebody actually worked in this repository. */
  entered: boolean;
  /** Every service here has a current implementation record. */
  implemented: boolean;
  /** Every service here is approved or completed. */
  verified: boolean;
};

export function repositoryProgress(state: WorkflowState): RepositoryProgress[] {
  return state.repositories.map((repo) => {
    const services = state.services.filter((s) => s.repositoryId === repo.id);
    const current = (serviceId: string) => state.implementationUnits.some((u) => u.serviceId === serviceId && !u.stale);
    return {
      repositoryId: repo.id,
      name: repo.name,
      role: repo.role,
      stories: state.stories.filter((s) => s.repositoryIds.includes(repo.id) && s.status !== "superseded" && s.status !== "excluded").map((s) => s.id),
      requirements: state.requirements.filter((r) => r.repositoryIds.includes(repo.id) && r.status !== "superseded").map((r) => r.id),
      services: services.map((s) => s.id),
      entered: services.some((s) => current(s.id)),
      implemented: services.length > 0 && services.every((s) => current(s.id)),
      verified: services.length > 0 && services.every((s) => s.status === "approved" || s.status === "completed"),
    };
  });
}

export type RepositoryBrief = {
  repository: { id: string; name: string; role: string; localPath?: string; remoteUrl?: string; branch?: string; inspected: boolean; inspectionSummary?: string; frameworks: string[] };
  requirements: Array<{ id: string; statement: string; criteria: string[] }>;
  stories: Array<{ id: string; title?: string; status: string; screenRefs: string[] }>;
  services: Array<{ id: string; name: string; status: string; dependsOn: string[]; hasImplementation: boolean }>;
  contracts: Array<{ id: string; name: string; role: "provides" | "consumes"; status: string; schemaRef?: string; counterparts: string[] }>;
  /** Services in other repositories this one waits for, and whether they are done. */
  waitsFor: Array<{ serviceId: string; repositoryId?: string; done: boolean }>;
  order: { position: number | null; of: number; sequence: string[]; cycle: string[] };
  impact?: { affected: Array<{ path?: string; area: string; change: string; risk?: string }>; regressionChecks: Array<{ id: string; statement: string }> };
  readyToStart: boolean;
  blockers: string[];
  forDeveloper: string[];
  forQuality: string[];
};

export function buildRepositoryBrief(state: WorkflowState, repositoryId: string): RepositoryBrief {
  const repo = state.repositories.find((r) => r.id === repositoryId);
  if (!repo) throw new Error(`repository ${repositoryId} is not registered in this work item`);
  const services = state.services.filter((s) => s.repositoryId === repo.id);
  const ids = new Set(services.map((s) => s.id));
  const { order, cycle } = implementationOrder(state);
  const done = (status: string) => status === "approved" || status === "completed";
  const waitsFor = services
    .flatMap((s) => s.dependsOn)
    .filter((dep, i, all) => !ids.has(dep) && all.indexOf(dep) === i)
    .map((dep) => {
      const service = state.services.find((s) => s.id === dep);
      return { serviceId: dep, repositoryId: service?.repositoryId, done: Boolean(service && (done(service.status) || state.implementationUnits.some((u) => u.serviceId === dep && !u.stale))) };
    });
  const requirements = state.requirements.filter((r) => r.status !== "superseded" && (r.repositoryIds.includes(repo.id) || state.stories.some((s) => s.repositoryIds.includes(repo.id) && s.status !== "superseded" && s.status !== "excluded" && s.requirementIds.includes(r.id))));
  const stories = state.stories.filter((s) => s.repositoryIds.includes(repo.id) && s.status !== "superseded" && s.status !== "excluded");
  const contracts = state.contracts.flatMap((c) => {
    const out: RepositoryBrief["contracts"] = [];
    if (ids.has(c.providerServiceId)) out.push({ id: c.id, name: c.name, role: "provides", status: c.status, schemaRef: c.schemaRef, counterparts: c.consumerServiceIds });
    if (c.consumerServiceIds.some((id) => ids.has(id))) out.push({ id: c.id, name: c.name, role: "consumes", status: c.status, schemaRef: c.schemaRef, counterparts: [c.providerServiceId] });
    return out;
  });
  const blockers: string[] = [];
  if (services.length === 0) blockers.push("no service is mapped to this repository (set-service with repositoryId)");
  for (const wait of waitsFor) if (!wait.done) blockers.push(`waits for ${wait.serviceId}${wait.repositoryId ? ` in ${wait.repositoryId}` : ""}`);
  for (const c of contracts) if (c.status !== "agreed") blockers.push(`contract ${c.id} (${c.role}) is only proposed`);
  const positions = services.map((s) => order.indexOf(s.id)).filter((i) => i >= 0);
  return {
    repository: {
      id: repo.id,
      name: repo.name,
      role: repo.role,
      localPath: repo.localPath,
      remoteUrl: repo.remoteUrl,
      branch: repo.branch,
      inspected: Boolean(repo.inspection),
      inspectionSummary: repo.inspection?.summary,
      frameworks: repo.inspection?.frameworks ?? [],
    },
    requirements: requirements.map((r) => ({ id: r.id, statement: r.statement, criteria: r.acceptanceCriteria.map((c) => `${c.id}: ${c.statement}`) })),
    stories: stories.map((s) => ({ id: s.id, title: s.title, status: s.status, screenRefs: s.screenRefs })),
    services: services.map((s) => ({ id: s.id, name: s.name, status: s.status, dependsOn: s.dependsOn, hasImplementation: state.implementationUnits.some((u) => u.serviceId === s.id && !u.stale) })),
    contracts,
    waitsFor,
    order: { position: positions.length ? Math.min(...positions) + 1 : null, of: order.length, sequence: order, cycle },
    impact: state.impact
      ? {
          affected: state.impact.affected.filter((a) => a.repositoryId === repo.id).map(({ path, area, change, risk }) => ({ path, area, change, risk })),
          regressionChecks: state.impact.regressionChecks.filter((c) => !c.serviceId || ids.has(c.serviceId)).map(({ id, statement }) => ({ id, statement })),
        }
      : undefined,
    readyToStart: blockers.length === 0,
    blockers,
    forDeveloper: [
      `Work only in ${repo.name}${repo.localPath ? ` (${repo.localPath})` : ""}; record an implementation for each of: ${services.map((s) => s.id).join(", ") || "(no service yet)"}.`,
      ...contracts.map((c) => `${c.role === "provides" ? "Provide" : "Consume"} contract ${c.name}${c.schemaRef ? ` (${c.schemaRef})` : ""}: do not change it without returning to the architect.`),
    ],
    forQuality: [
      `Verify ${services.map((s) => s.id).join(", ") || "this repository"} against ${requirements.map((r) => r.id).join(", ") || "its requirements"} by running its own checks.`,
      ...contracts.map((c) => `Check contract ${c.name} from this side (${c.role}).`),
      ...(state.impact?.regressionChecks.map((c) => `Regression: ${c.statement}`) ?? []),
    ],
  };
}
