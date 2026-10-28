import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, evaluateEvidence, evaluateFeature, openLocalWorkflow, requirementCoverage, storyCoverage, type WorkflowState } from "./index.js";

const EXEC = { evidenceSource: { kind: "executed" as const, artifacts: [], runId: "run-1" } };
const R1 = "REQ-QCV-001";
const R2 = "REQ-QCV-002";

function entry(req: string, n: number, status: "PASS" | "FAIL" | "BLOCKED" | "NOT_VERIFIED" | "PASS_WITH_RISKS" = "PASS", extra: Record<string, unknown> = {}) {
  const ac = `${req}-AC-0${n}`;
  return { storyId: req === R1 ? "US-QCV-001" : "US-QCV-002", requirementId: req, acceptanceCriterionId: ac, scenarioId: `S-${ac}`, kind: "happy" as const, serviceId: "svc", repository: "r", implementationPath: "x.js", testRef: "x.js", evidence: ["level:unit"], status, critical: true, ...extra };
}

function base(): WorkflowState {
  let s = openLocalWorkflow({ mode: "classic", projectId: "qcv", title: "Coverage", request: "Coverage" });
  const ok = (c: Record<string, unknown>) => (s = applyWorkflowCommand(s, c).state);
  ok({ action: "add-requirement", id: R1, statement: "Seven criteria", acceptanceCriteria: Array.from({ length: 7 }, (_, i) => `criterion ${i + 1}`) });
  ok({ action: "add-requirement", id: R2, statement: "Two criteria", acceptanceCriteria: ["one", "two"] });
  for (const [id, req, n] of [["US-QCV-001", R1, 7], ["US-QCV-002", R2, 2]] as const) {
    ok({ action: "add-story", id, requirementIds: [req], actor: "user", narrative: "As a user, I want it, so that I benefit.", objective: "o", userValue: "v", happyPath: ["do"], acceptanceCriteria: Array.from({ length: n }, (_, i) => ({ id: `${req}-AC-0${i + 1}`, given: "g", when: "w", then: "t" })), expectedResults: ["done"], serviceIds: ["svc"], confirmedBehavior: false });
  }
  // the person confirmed both stories (the confirmation itself is covered by its own tests)
  return { ...s, stories: s.stories.map((st) => ({ ...st, confirmedBehavior: true, status: "confirmed" as const })) };
}

const record = (s: WorkflowState, scenarios: ReturnType<typeof entry>[], more: Record<string, unknown> = {}, opts: Parameters<typeof applyWorkflowCommand>[2] = EXEC) =>
  applyWorkflowCommand(s, { action: "record-verification", independentRerun: true, scenarios, ...more }, opts);
const all = (req: string, n: number, status: "PASS" | "FAIL" = "PASS") => Array.from({ length: n }, (_, i) => entry(req, i + 1, status));

describe("S17: PASS needs every current acceptance criterion", () => {
  it("3 of 7 criteria passed is not PASS, and the counts say why", () => {
    const s = record(base(), [entry(R1, 4), entry(R1, 5), entry(R1, 6)]).state;
    const cov = requirementCoverage(s, R1);
    expect(cov.verdict).not.toBe("PASS");
    expect(cov.counts).toMatchObject({ total: 7, verified: 3, passed: 3, failed: 0, blocked: 0, missing: 4 });
    expect(cov.reasons.join("\n")).toContain(`${R1}-AC-01 has no evidence`);
    expect(storyCoverage(s, "US-QCV-001").verdict).not.toBe("PASS");
  });

  it("all 7 criteria passed is PASS", () => {
    const s = record(base(), all(R1, 7)).state;
    expect(requirementCoverage(s, R1)).toMatchObject({ verdict: "PASS", counts: { total: 7, passed: 7, missing: 0 } });
    expect(storyCoverage(s, "US-QCV-001").verdict).toBe("PASS");
  });

  it("empty coverage: nothing is verified, no PASS and no recorded requirement verdict", () => {
    const s = record(base(), []).state;
    expect(requirementCoverage(s, R1)).toMatchObject({ verdict: "FAIL", noEvidence: true, counts: { total: 7, missing: 7 } });
    expect(s.verdicts.filter((v) => v.scope === "requirement")).toEqual([]);
    expect(evaluateFeature(s).verdict).toBe("FAIL");
  });

  it("a FAIL, a critical BLOCKED and a critical NOT_VERIFIED each keep the requirement from PASS and are named by criterion", () => {
    for (const status of ["FAIL", "BLOCKED", "NOT_VERIFIED"] as const) {
      const scenarios = all(R2, 2).map((e, i) => (i === 1 ? { ...e, status } : e));
      const s = record(base(), scenarios).state;
      const cov = requirementCoverage(s, R2);
      expect(cov.verdict, status).toBe("FAIL");
      expect(cov.reasons.join("\n"), status).toContain(`${R2}-AC-02`);
    }
  });

  it("results for an older revision of a Story or of a criterion are stale and prove nothing", () => {
    let s = record(base(), all(R2, 2)).state;
    expect(requirementCoverage(s, R2).verdict).toBe("PASS");
    const revised = { ...s, stories: s.stories.map((st) => (st.id === "US-QCV-002" ? { ...st, revision: st.revision + 1 } : st)) };
    expect(requirementCoverage(revised, R2)).toMatchObject({ verdict: "FAIL", noEvidence: true, counts: { stale: 2 } });
    s = { ...s, requirements: s.requirements.map((r) => (r.id === R2 ? { ...r, acceptanceCriteria: r.acceptanceCriteria.map((c, i) => (i === 0 ? { ...c, revision: 2 } : c)) } : r)) };
    const cov = requirementCoverage(s, R2);
    expect(cov.counts).toMatchObject({ passed: 1, stale: 1 });
    expect(cov.verdict).toBe("FAIL");
    expect(cov.reasons.join("\n")).toContain("older revision");
  });

  it("a result an agent wrote without a Runtime run is attested: never PASS", () => {
    const s = record(base(), all(R2, 2), {}, {}).state;
    const cov = requirementCoverage(s, R2);
    expect(cov.counts).toMatchObject({ attested: 2, passed: 0 });
    expect(cov.verdict).toBe("PASS_WITH_RISKS");
    expect(s.coverage.every((e) => e.source?.kind === "agent")).toBe(true);
  });

  it("an agent cannot claim an executed source or another criterion revision in what it records", () => {
    const forged = { ...entry(R2, 1), source: { kind: "executed", runId: "fake", artifacts: [] }, acceptanceCriterionRevision: 9, recordedAt: "2000-01-01T00:00:00.000Z" };
    const s = record(base(), [forged as never], {}, {}).state;
    expect(s.coverage[0]).toMatchObject({ source: { kind: "agent" }, acceptanceCriterionRevision: 1 });
    expect(s.coverage[0]!.recordedAt).not.toBe("2000-01-01T00:00:00.000Z");
  });
});

describe("S18: one verdict model", () => {
  it("the feature verdict verify-stories records is the evidence part of what feature-verdict computes", () => {
    // checks that cover only REQ-QCV-001: the feature cannot be PASS
    const recorded = record(base(), all(R1, 7));
    const feature = (recorded.result as { verdict: string }).verdict;
    expect(feature).toBe("FAIL");
    const computed = evaluateFeature(recorded.state);
    expect(computed.evidence.verdict).toBe(feature);
    expect(computed.gaps.join("\n")).toContain(`${R2}: no evidence for any of 2 acceptance criteria`);
    expect(recorded.state.verdicts.filter((v) => v.scope === "feature").at(-1)?.verdict).toBe(feature);
  });

  it("when every requirement is proven the evidence verdict is PASS and only readiness can still hold the feature back", () => {
    const s = record(base(), [...all(R1, 7), ...all(R2, 2)]).state;
    expect(evaluateEvidence(s)).toMatchObject({ verdict: "PASS", gaps: [], totals: { total: 9, passed: 9 } });
    const feature = evaluateFeature(s);
    expect(feature.evidence.verdict).toBe("PASS");
    expect(feature.verdict).toBe("FAIL");
    expect(feature.readinessGaps).toContain("no services");
  });

  it("every non-PASS names the requirement, the criteria and the scenarios behind it", () => {
    const s = record(base(), [entry(R1, 1), entry(R1, 2, "FAIL"), ...all(R2, 2)]).state;
    const gaps = evaluateEvidence(s).gaps.join("\n");
    expect(gaps).toContain(`${R1}-AC-02 FAILED (S-${R1}-AC-02)`);
    expect(gaps).toContain(`${R1}-AC-03 has no evidence`);
  });
});

describe("S19: record-verification merges instead of replacing", () => {
  it("recording one criterion keeps the others and bumps the coverage revision once", () => {
    const first = record(base(), [entry(R1, 1), entry(R1, 2)]).state;
    const second = record(first, [entry(R1, 3)]).state;
    expect(second.coverage.map((e) => e.scenarioId)).toEqual([`S-${R1}-AC-01`, `S-${R1}-AC-02`, `S-${R1}-AC-03`]);
    expect(second.coverageRevision).toBe(first.coverageRevision + 1);
  });

  it("an identical repeat changes nothing; a changed result replaces the entry in place and keeps its id", () => {
    const first = record(base(), [entry(R1, 1)]).state;
    const again = record(first, [entry(R1, 1)]).state;
    expect(again.coverage).toEqual(first.coverage);
    expect(again.coverageRevision).toBe(first.coverageRevision);
    const fixed = record(first, [entry(R1, 1, "FAIL")]).state;
    expect(fixed.coverage).toHaveLength(1);
    expect(fixed.coverage[0]).toMatchObject({ scenarioId: `S-${R1}-AC-01`, status: "FAIL" });
    const reverified = record(fixed, [entry(R1, 1, "PASS")]).state;
    expect(reverified.coverage[0]!.status).toBe("PASS");
  });

  it("a scenario id cannot be moved to another criterion", () => {
    const first = record(base(), [entry(R1, 1)]).state;
    expect(() => record(first, [{ ...entry(R1, 2), scenarioId: `S-${R1}-AC-01` }])).toThrow(/EVIDENCE_ID_CONFLICT|already proves/);
  });

  it("an agent record cannot overwrite or retire executed evidence", () => {
    const first = record(base(), [entry(R1, 1)]).state;
    expect(() => record(first, [entry(R1, 1, "FAIL")], {}, {})).toThrow(/cannot overwrite/);
    const after = record(first, [], { retire: [`S-${R1}-AC-01`] }, {}).state;
    expect(after.coverage).toHaveLength(1);
    expect(() => record(first, [], { replaceSource: "executed" }, {})).toThrow(/cannot replace/);
  });

  it("a complete re-run replaces only its own source: browser evidence survives a verify-stories re-run", () => {
    const browser = { evidenceSource: { kind: "browser" as const, artifacts: [], runId: "b1" } };
    let s = record(base(), [entry(R1, 1), entry(R1, 2)]).state;
    s = record(s, [entry(R2, 1, "PASS", { scenarioId: "B-1" })], {}, browser).state;
    s = record(s, [entry(R1, 1)], { replaceSource: "executed" }).state;
    expect(s.coverage.map((e) => e.scenarioId).sort()).toEqual(["B-1", `S-${R1}-AC-01`]);
  });

  it("a writer that saw older coverage is refused", () => {
    const first = record(base(), [entry(R1, 1)]).state;
    const second = record(first, [entry(R1, 2)]).state;
    expect(() => record(second, [entry(R1, 3)], { baseCoverageRevision: first.coverageRevision })).toThrow(/EVIDENCE_STALE|coverage is at revision/);
    expect(() => record(second, [entry(R1, 3)], { baseCoverageRevision: second.coverageRevision })).not.toThrow();
  });

  it("a scenario for a requirement or criterion that does not exist is refused", () => {
    expect(() => record(base(), [{ ...entry(R1, 1), requirementId: "REQ-NOPE-001" }])).toThrow(/not a current requirement/);
    expect(() => record(base(), [{ ...entry(R2, 1), acceptanceCriterionId: "REQ-QCV-002-AC-99", storyId: undefined } as never])).toThrow(/does not have/);
  });
});
