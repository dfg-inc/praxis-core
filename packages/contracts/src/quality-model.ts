import type { CoverageEntry } from "./story.js";
import type { WorkflowState } from "./workflow.js";

/**
 * One model for "what has been proven". Requirement, Story, Service and Feature results all come from `criterionStatus`
 * over the same coverage entries, so verify-stories, quality-check and feature-verdict cannot disagree about one state.
 *
 * A criterion is
 *   passed    - a current, independently executed PASS, and nothing failing or blocked beside it
 *   failed    - a current FAIL
 *   blocked   - only (or also) critical BLOCKED / NOT_VERIFIED results: it could not be proven
 *   stale     - the only results are for an older revision of the Story or of the criterion
 *   attested  - the only PASS was written by an agent (record-verification without a Runtime run): not independent
 *   risk      - only PASS_WITH_RISKS
 *   missing   - no result at all
 * A requirement or Story is PASS only when EVERY current criterion is passed.
 */

export type CriterionState = "passed" | "failed" | "blocked" | "stale" | "attested" | "risk" | "missing";

export type CriterionCoverage = { id: string; revision: number; state: CriterionState; scenarios: string[]; stale: string[] };

export type CoverageCounts = {
  total: number;
  /** Criteria with a conclusive current result: passed or failed. */
  verified: number;
  passed: number;
  failed: number;
  blocked: number;
  missing: number;
  stale: number;
  attested: number;
  risk: number;
};

export type Verdict = "PASS" | "PASS_WITH_RISKS" | "FAIL";

export type CoverageResult = {
  id: string;
  counts: CoverageCounts;
  criteria: CriterionCoverage[];
  verdict: Verdict;
  /** Where each non-PASS comes from: one line per criterion or Story problem, naming the AC and the scenarios. */
  reasons: string[];
  /** true when no current evidence exists at all (the verdict is then not recorded: nothing was verified). */
  noEvidence: boolean;
};

const TRUSTED = new Set(["executed", "browser", "legacy"]);

/** Entries written before provenance existed have no source: they count as executed (they could only come from verify-stories) but only for unrevised criteria. */
function trusted(entry: CoverageEntry): boolean {
  return TRUSTED.has(entry.source?.kind ?? "legacy");
}

type Located = { entry: CoverageEntry; current: boolean };

function locate(state: WorkflowState, entry: CoverageEntry, ac: { id: string; revision: number } | undefined): Located {
  let current = true;
  if (entry.storyId !== undefined) {
    const story = state.stories.find((s) => s.id === entry.storyId);
    if (!story || story.status === "superseded" || story.status === "excluded") current = false;
    // entries written before storyRevision existed only count for an unrevised Story
    else if ((entry.storyRevision ?? 1) !== story.revision) current = false;
  }
  if (current && ac) {
    // entries written before criterion revisions were recorded only count for an unrevised criterion
    if ((entry.acceptanceCriterionRevision ?? 1) !== ac.revision) current = false;
  }
  return { entry, current };
}

export function criterionStatus(state: WorkflowState, requirementId: string, ac: { id: string; revision: number } | undefined, acId: string): CriterionCoverage {
  const mine = state.coverage.filter((e) => e.requirementId === requirementId && e.acceptanceCriterionId === acId && !e.scenarioId.endsWith("-CONFIRMATION"));
  const located = mine.map((e) => locate(state, e, ac));
  const current = located.filter((l) => l.current).map((l) => l.entry);
  const stale = located.filter((l) => !l.current).map((l) => l.entry.scenarioId);
  const base = { id: acId, revision: ac?.revision ?? 1, scenarios: current.map((e) => e.scenarioId), stale };
  if (current.length === 0) return { ...base, state: stale.length ? "stale" : "missing" };
  if (current.some((e) => e.status === "FAIL")) return { ...base, state: "failed" };
  if (current.some((e) => (e.status === "BLOCKED" || e.status === "NOT_VERIFIED") && e.critical)) return { ...base, state: "blocked" };
  const passes = current.filter((e) => e.status === "PASS");
  if (passes.some(trusted)) return { ...base, state: "passed" };
  if (passes.length) return { ...base, state: "attested" };
  if (current.some((e) => e.status === "PASS_WITH_RISKS")) return { ...base, state: "risk" };
  return { ...base, state: "blocked" };
}

function count(criteria: CriterionCoverage[]): CoverageCounts {
  const n = (s: CriterionState) => criteria.filter((c) => c.state === s).length;
  return { total: criteria.length, verified: n("passed") + n("failed"), passed: n("passed"), failed: n("failed"), blocked: n("blocked"), missing: n("missing"), stale: n("stale"), attested: n("attested"), risk: n("risk") };
}

function describe(c: CriterionCoverage): string {
  switch (c.state) {
    case "failed":
      return `${c.id} FAILED (${c.scenarios.join(", ")})`;
    case "blocked":
      return `${c.id} could not be proven: BLOCKED or not verified (${c.scenarios.join(", ")})`;
    case "stale":
      return `${c.id} only has results for an older revision (${c.stale.join(", ")}): verify it again`;
    case "attested":
      return `${c.id} is attested by an agent, not independently executed (${c.scenarios.join(", ")})`;
    case "risk":
      return `${c.id} passed with risks (${c.scenarios.join(", ")})`;
    case "missing":
      return `${c.id} has no evidence`;
    default:
      return "";
  }
}

function verdictOf(counts: CoverageCounts, extraRisks: number): Verdict {
  if (counts.failed > 0 || counts.blocked > 0 || counts.missing > 0 || counts.stale > 0) return "FAIL";
  if (counts.attested > 0 || counts.risk > 0 || extraRisks > 0) return "PASS_WITH_RISKS";
  return "PASS";
}

/** In-scope, current requirements: the ones a feature verdict has to account for. */
export function requiredRequirements(state: WorkflowState) {
  return state.requirements.filter((r) => r.status !== "superseded" && r.scope === "in");
}

export function requirementCoverage(state: WorkflowState, requirementId: string): CoverageResult {
  const requirement = state.requirements.find((r) => r.id === requirementId && r.status !== "superseded");
  const reasons: string[] = [];
  let criteria: CriterionCoverage[];
  if (!requirement) return { id: requirementId, counts: count([]), criteria: [], verdict: "FAIL", reasons: ["not a current requirement"], noEvidence: true };
  if (requirement.acceptanceCriteria.length > 0) {
    criteria = requirement.acceptanceCriteria.map((ac) => criterionStatus(state, requirementId, ac, ac.id));
  } else {
    // no criteria to count: the requirement is proven by its own requirement-level scenarios
    const ids = [...new Set(state.coverage.filter((e) => e.requirementId === requirementId).map((e) => e.acceptanceCriterionId))];
    criteria = ids.map((id) => criterionStatus(state, requirementId, undefined, id));
  }
  const counts = count(criteria);
  for (const c of criteria) {
    const line = describe(c);
    if (line) reasons.push(line);
  }
  let extraRisks = 0;
  for (const story of state.stories.filter((s) => s.status !== "superseded" && s.status !== "excluded" && s.requirementIds.includes(requirementId))) {
    const verified = state.coverage.some((e) => e.storyId === story.id && e.requirementId === requirementId && (e.storyRevision ?? 1) === story.revision && !e.scenarioId.endsWith("-CONFIRMATION"));
    if (!verified) {
      reasons.push(`story-not-verified:${story.id}@${story.revision}`);
      extraRisks += 1;
    } else if (!story.confirmedBehavior) {
      reasons.push(`story-unconfirmed:${story.id}@${story.revision}`);
      extraRisks += 1;
    }
  }
  const noEvidence = criteria.every((c) => c.state === "missing" || c.state === "stale");
  const verdict = noEvidence ? "FAIL" : verdictOf(counts, extraRisks);
  return { id: requirementId, counts, criteria, verdict, reasons, noEvidence };
}

/** A Story is proven when every one of its own criteria is. The criteria ids of a Story are usually the requirement criteria it covers. */
export function storyCoverage(state: WorkflowState, storyId: string): CoverageResult {
  const story = state.stories.find((s) => s.id === storyId);
  if (!story) return { id: storyId, counts: count([]), criteria: [], verdict: "FAIL", reasons: ["unknown story"], noEvidence: true };
  const criteria = story.acceptanceCriteria.map((sc) => {
    const owner = story.requirementIds.map((rid) => state.requirements.find((r) => r.id === rid)).find((r) => r?.acceptanceCriteria.some((c) => c.id === sc.id));
    const ac = owner?.acceptanceCriteria.find((c) => c.id === sc.id);
    if (owner && ac) return criterionStatus(state, owner.id, ac, sc.id);
    // a Story-own criterion: results bound to this Story and this id
    const entries = state.coverage.filter((e) => e.storyId === storyId && e.acceptanceCriterionId === sc.id);
    const located = entries.map((e) => locate(state, e, undefined));
    const cur = located.filter((l) => l.current).map((l) => l.entry);
    const st: CriterionState = !cur.length ? (entries.length ? "stale" : "missing") : cur.some((e) => e.status === "FAIL") ? "failed" : cur.some((e) => (e.status === "BLOCKED" || e.status === "NOT_VERIFIED") && e.critical) ? "blocked" : cur.some((e) => e.status === "PASS" && trusted(e)) ? "passed" : cur.some((e) => e.status === "PASS") ? "attested" : "risk";
    return { id: sc.id, revision: 1, state: st, scenarios: cur.map((e) => e.scenarioId), stale: located.filter((l) => !l.current).map((l) => l.entry.scenarioId) };
  });
  const counts = count(criteria);
  const reasons = criteria.map(describe).filter(Boolean);
  if (!story.confirmedBehavior) reasons.push(`story-unconfirmed:${story.id}@${story.revision}`);
  const noEvidence = criteria.every((c) => c.state === "missing" || c.state === "stale");
  return { id: storyId, counts, criteria, verdict: noEvidence ? "FAIL" : verdictOf(counts, story.confirmedBehavior ? 0 : 1), reasons, noEvidence };
}

export type FeatureEvaluation = {
  verdict: Verdict;
  /** What stands between the evidence and PASS, each naming requirement, criteria and scenarios. */
  gaps: string[];
  requirements: Array<{ id: string; verdict: Verdict; counts: CoverageCounts }>;
  stories: Array<{ id: string; verdict: Verdict; counts: CoverageCounts }>;
  totals: CoverageCounts;
};

/** The evidence part of the feature verdict. Workflow readiness (implementation records, approved services) is added by evaluateFeature. */
export function evaluateEvidence(state: WorkflowState): FeatureEvaluation {
  const gaps: string[] = [];
  const reqs = requiredRequirements(state);
  if (reqs.length === 0) gaps.push("no requirements in scope");
  const requirements = reqs.map((r) => {
    const cov = requirementCoverage(state, r.id);
    if (cov.verdict !== "PASS") {
      const head = cov.noEvidence ? `${r.id}: no evidence for any of ${cov.counts.total} acceptance criteria` : `${r.id} is ${cov.verdict}: ${cov.counts.passed} of ${cov.counts.total} criteria passed (failed ${cov.counts.failed}, blocked ${cov.counts.blocked}, missing ${cov.counts.missing}, stale ${cov.counts.stale}, attested ${cov.counts.attested})`;
      gaps.push(head);
      if (!cov.noEvidence) for (const reason of cov.reasons) gaps.push(`  ${reason}`);
    }
    return { id: r.id, verdict: cov.verdict, counts: cov.counts };
  });
  const stories = state.stories
    .filter((s) => s.status !== "superseded" && s.status !== "excluded")
    .map((s) => {
      const cov = storyCoverage(state, s.id);
      return { id: s.id, verdict: cov.verdict, counts: cov.counts };
    });
  const totals = requirements.reduce((sum, r) => ({ total: sum.total + r.counts.total, verified: sum.verified + r.counts.verified, passed: sum.passed + r.counts.passed, failed: sum.failed + r.counts.failed, blocked: sum.blocked + r.counts.blocked, missing: sum.missing + r.counts.missing, stale: sum.stale + r.counts.stale, attested: sum.attested + r.counts.attested, risk: sum.risk + r.counts.risk }), count([]));
  const verdict: Verdict = requirements.length === 0 || requirements.some((r) => r.verdict === "FAIL") ? "FAIL" : requirements.some((r) => r.verdict === "PASS_WITH_RISKS") ? "PASS_WITH_RISKS" : "PASS";
  return { verdict, gaps, requirements, stories, totals };
}
