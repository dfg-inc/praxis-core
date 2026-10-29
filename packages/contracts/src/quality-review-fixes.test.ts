import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, capabilityEvidence, evaluateEvidence, maskLiterals, openLocalWorkflow, phaseGates, requirementCoverage, statedOperations, type WorkflowState } from "./index.js";

const NOW = new Date("2026-10-29T10:00:00.000Z");
const EXEC = { evidenceSource: { kind: "executed" as const, artifacts: [], runId: "run-1" }, now: NOW };
const R = "REQ-QRF-001";

function entry(ac: string, status: "PASS" | "FAIL" = "PASS", id = `S-${ac}`, storyId = "US-QRF-001") {
  return { storyId, requirementId: R, acceptanceCriterionId: ac, scenarioId: id, kind: "happy" as const, serviceId: "svc", repository: "r", implementationPath: "x.js", testRef: "x.js", evidence: ["level:unit"], status, critical: true };
}
function base(extraStoryCriterion = false): WorkflowState {
  let s = openLocalWorkflow({ mode: "classic", projectId: "qrf", title: "Review fixes", request: "x" });
  s = applyWorkflowCommand(s, { action: "add-requirement", id: R, statement: "Statement", acceptanceCriteria: ["one", "two"] }, { now: NOW }).state;
  s = applyWorkflowCommand(s, { action: "add-story", id: "US-QRF-001", requirementIds: [R], actor: "manager", narrative: "As a manager, I want it, so that I benefit.", objective: "o", userValue: "v", happyPath: ["do"], acceptanceCriteria: [{ id: `${R}-AC-01`, given: "g", when: "w", then: "t" }, { id: `${R}-AC-02`, given: "g", when: "w", then: "t" }, ...(extraStoryCriterion ? [{ id: "US-QRF-001-OWN", given: "g", when: "w", then: "t" }] : [])], expectedResults: ["done"], serviceIds: ["svc"], confirmedBehavior: false }, { now: NOW }).state;
  return { ...s, stories: s.stories.map((st) => ({ ...st, confirmedBehavior: true, status: "confirmed" as const })) };
}
const record = (s: WorkflowState, scenarios: ReturnType<typeof entry>[], opts: Parameters<typeof applyWorkflowCommand>[2] = EXEC) => applyWorkflowCommand(s, { action: "record-verification", independentRerun: true, scenarios }, opts).state;

describe("round 7 review: Story criteria, scenario ids, retired criteria", () => {
  it("a Story-own criterion that FAILS (or has no result) cannot hide behind a passing requirement", () => {
    const s = record(base(true), [entry(`${R}-AC-01`), entry(`${R}-AC-02`), entry("US-QRF-001-OWN", "FAIL")]);
    expect(requirementCoverage(s, R).verdict).toBe("PASS");
    const ev = evaluateEvidence(s);
    expect(ev.verdict).toBe("FAIL");
    expect(ev.gaps.join("\n")).toContain("US-QRF-001 is FAIL");
    expect(s.verdicts.filter((v) => v.scope === "feature").at(-1)?.verdict).toBe("FAIL");
    const unproven = record(base(true), [entry(`${R}-AC-01`), entry(`${R}-AC-02`)]);
    expect(evaluateEvidence(unproven).verdict).toBe("FAIL");
  });

  it("a scenario id ending in -CONFIRMATION is an ordinary scenario: it cannot hide a FAIL", () => {
    const s = record(base(), [entry(`${R}-AC-01`), entry(`${R}-AC-02`), entry(`${R}-AC-02`, "FAIL", "S1-CONFIRMATION")]);
    expect(requirementCoverage(s, R).verdict).toBe("FAIL");
    expect(evaluateEvidence(s).verdict).toBe("FAIL");
  });

  it("a removed criterion's id is never handed out again, so its old PASS cannot count for a new criterion", () => {
    let s = record(base(), [entry(`${R}-AC-01`), entry(`${R}-AC-02`)]);
    expect(requirementCoverage(s, R).verdict).toBe("PASS");
    s = applyWorkflowCommand(s, { action: "review-requirements", via: "html-review", decisions: [{ requirementId: R, acceptance: [], addAcceptance: [], removeAcceptance: [`${R}-AC-02`] }] }, { now: NOW, channel: { via: "html-review" } }).state;
    s = applyWorkflowCommand(s, { action: "review-requirements", via: "html-review", decisions: [{ requirementId: R, acceptance: [], addAcceptance: [{ statement: "BRAND NEW, different" }], removeAcceptance: [] }] }, { now: NOW, channel: { via: "html-review" } }).state;
    const ids = s.requirements[0]!.acceptanceCriteria.map((c) => c.id);
    expect(ids).toEqual([`${R}-AC-01`, `${R}-AC-03`]);
    // the requirement was revised, so the earlier results are stale; the new criterion has nothing, in particular not the removed one's PASS
    expect(requirementCoverage(s, R).criteria.find((c) => c.id === `${R}-AC-03`)?.state).toBe("missing");
    expect(requirementCoverage(s, R).counts.passed).toBe(0);
  });

  it("results with no recorded provenance are not independent proof; the delivery gate looks at the evidence as it is now", () => {
    let s = record(base(), [entry(`${R}-AC-01`), entry(`${R}-AC-02`)]);
    // the same state as alpha.48 would have saved it: no source
    const legacy = { ...s, coverage: s.coverage.map(({ source: _s, recordedAt: _r, acceptanceCriterionRevision: _a, ...rest }) => rest) };
    expect(requirementCoverage(legacy, R)).toMatchObject({ counts: { attested: 2, passed: 0 }, verdict: "PASS_WITH_RISKS" });
    expect(requirementCoverage(legacy, R).reasons.join("\n")).toContain("recorded before provenance existed");
    // a recorded PASS verdict from before does not open delivery
    const withOldVerdict = { ...legacy, verdicts: [...legacy.verdicts, { id: "V-OLD", scope: "feature" as const, scopeId: s.workItem.id, verdict: "PASS" as const, evidenceRefs: [], requirementIds: [R], stale: false }] };
    const gate = phaseGates({ ...withOldVerdict, implementationUnits: [], services: [] }, "delivery");
    expect(gate.missing.join("\n")).toContain("independently executed");
    // an agent-only record does not open it either
    const agentOnly = record(base(), [entry(`${R}-AC-01`), entry(`${R}-AC-02`)], { now: NOW });
    expect(phaseGates(agentOnly, "delivery").missing.join("\n")).toContain("independently executed");
    // executed results do
    s = record(base(), [entry(`${R}-AC-01`), entry(`${R}-AC-02`)]);
    expect(phaseGates(s, "delivery").missing.join("\n")).not.toContain("independently executed");
    expect(phaseGates(s, "delivery").missing.join("\n")).not.toContain("evidence for the current");
  });

  it("the development and quality gates stay shut for a story that was edited (unconfirmed) after the stories review", () => {
    const s = base();
    const edited = { ...s, stories: s.stories.map((st) => ({ ...st, confirmedBehavior: false, status: "proposed" as const })) };
    for (const to of ["architecture", "development", "quality"] as const) {
      expect(phaseGates(edited, to).missing.join("\n"), to).toContain("every story confirmed by the user");
      expect(phaseGates(s, to).missing.join("\n"), to).not.toContain("every story confirmed");
    }
  });
});

describe("round 7 re-review: criterion ids removed before the upgrade", () => {
  it("an id that only survives in coverage (removed before retiredCriteria existed) is not handed out again", () => {
    let s = record(base(), [entry(`${R}-AC-01`), entry(`${R}-AC-02`)]);
    // the state as an older version saved it: AC-02 gone, no retired list, its result still in coverage
    s = { ...s, requirements: s.requirements.map((r) => ({ ...r, retiredCriteria: [], acceptanceCriteria: r.acceptanceCriteria.filter((c) => c.id !== `${R}-AC-02`) })) };
    s = applyWorkflowCommand(s, { action: "review-requirements", via: "html-review", decisions: [{ requirementId: R, acceptance: [], addAcceptance: [{ statement: "new" }], removeAcceptance: [] }] }, { now: NOW, channel: { via: "html-review" } }).state;
    expect(s.requirements[0]!.acceptanceCriteria.map((c) => c.id)).toEqual([`${R}-AC-01`, `${R}-AC-03`]);
  });
});

describe("round 7 review: capability masking keeps real operations", () => {
  it("possessives and abbreviations do not hide operations; an option value is masked only in its own case", () => {
    expect(statedOperations("The customer can view the customer's list and delete the customer's order.").map((o) => o.capability).sort()).toEqual(["delete", "view"]);
    expect(statedOperations("A manager can edit an order's status and cancel the order's items.").map((o) => o.capability).sort()).toEqual(["delete", "edit"]);
    expect(statedOperations("Users can see orders (e.g. open one) and delete them").map((o) => o.capability).sort()).toEqual(["delete", "view"]);
    expect(statedOperations("Users can delete orders", ["Delete", "Open"]).map((o) => o.capability)).toEqual(["delete"]);
    expect(capabilityEvidence(maskLiterals("status 'Cancelled' and \"New\" and `create`", [])).map((e) => e.capability)).toEqual([]);
    expect(maskLiterals("Orders with status Delete are listed", ["Delete"])).not.toContain("Delete");
    expect(() => maskLiterals("x".repeat(100_000), ["(a+)+"])).not.toThrow();
  });
});
