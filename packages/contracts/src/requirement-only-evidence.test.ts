import { describe, expect, it } from "vitest";
import {
  applyWorkflowCommand,
  openLocalWorkflow,
  requirementEvidence,
  WorkflowCommandSchema,
  WorkflowStateSchema,
  type WorkflowState,
} from "./index.js";

const REQ = "REQ-QRO-901" as const;

function base(criteria = ["First holds.", "Second holds."]): WorkflowState {
  const state = openLocalWorkflow({ mode: "classic", projectId: "qro", title: "Requirement only", request: "No stories here" });
  return applyWorkflowCommand(state, {
    action: "add-requirement",
    id: REQ,
    statement: "Behaviour defined only by acceptance criteria.",
    acceptanceCriteria: criteria,
  }).state;
}

function scenario(criterion: string, status: "PASS" | "FAIL", id = `S-${criterion}`) {
  return {
    requirementId: REQ,
    acceptanceCriterionId: criterion,
    scenarioId: id,
    kind: "happy" as const,
    serviceId: "svc",
    repository: "repo",
    implementationPath: "dist/x.js",
    testRef: "dist/x.js",
    evidence: ["level:unit"],
    status,
    critical: true,
  };
}

function verify(state: WorkflowState, scenarios: ReturnType<typeof scenario>[]) {
  return applyWorkflowCommand(state, { action: "record-verification", independentRerun: true, scenarios });
}

describe("requirement-only verification (no Story)", () => {
  it("regression: the command and persisted-state schemas accept coverage without a storyId", () => {
    // Original defect: CoverageEntrySchema required a storyId, so MCP input and saved state were rejected.
    const command = { action: "record-verification", independentRerun: true, scenarios: [scenario(`${REQ}-AC-01`, "PASS")] };
    expect(() => WorkflowCommandSchema.parse(command)).not.toThrow();
    const verified = verify(base(), [scenario(`${REQ}-AC-01`, "PASS")]).state;
    expect(() => WorkflowStateSchema.parse(JSON.parse(JSON.stringify(verified)))).not.toThrow();
  });

  it("regression: coverage without a storyId is accepted and produces a requirement verdict", () => {
    // Original defect: coverage required a storyId, so a requirement-only item could never be verified.
    const verified = verify(base(), [scenario(`${REQ}-AC-01`, "PASS"), scenario(`${REQ}-AC-02`, "PASS")]);
    const verdicts = verified.state.verdicts.filter((v) => v.scope === "requirement" && v.scopeId === REQ);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.verdict).toBe("PASS");
    expect(verdicts[0]?.evidenceRefs).toEqual(expect.arrayContaining([`requirement:${REQ}@1`, `S-${REQ}-AC-01:PASS`]));
  });

  it("an acceptance criterion without a passing scenario caps the verdict at PASS_WITH_RISKS", () => {
    const evidence = requirementEvidence(verify(base(), [scenario(`${REQ}-AC-01`, "PASS")]).state, REQ);
    expect(evidence.status).toBe("executed");
    if (evidence.status !== "executed") return;
    expect(evidence.verdict).toBe("PASS_WITH_RISKS");
    expect(evidence.reasons).toEqual([`ac-not-verified:${REQ}-AC-02`]);
  });

  it("a failing scenario is FAIL even when other criteria pass", () => {
    const state = verify(base(), [scenario(`${REQ}-AC-01`, "PASS"), scenario(`${REQ}-AC-02`, "FAIL")]).state;
    const evidence = requirementEvidence(state, REQ);
    expect(evidence.status === "executed" && evidence.verdict).toBe("FAIL");
  });

  it("without coverage the evidence is missing, never a pass", () => {
    expect(requirementEvidence(base(), REQ).status).toBe("missing");
  });

  it("quality-check uses the same evidence and raises no missing-evidence finding", () => {
    const state = verify(base(), [scenario(`${REQ}-AC-01`, "PASS"), scenario(`${REQ}-AC-02`, "PASS")]).state;
    const checked = applyWorkflowCommand(state, { action: "quality-check", requirementId: REQ, testsGreen: true });
    expect(checked.result).toMatchObject({ verdict: "PASS", evidenceStatus: "executed", finding: null });
  });

  it("is not easier than a Story-based pass: a linked Story with no coverage keeps it below PASS", () => {
    let state = applyWorkflowCommand(base(), {
      action: "add-story",
      id: "US-QRO-001",
      requirementIds: [REQ],
      actor: "operator",
      narrative: "As a operator, I want the behaviour, so that value is delivered.",
      objective: "Behaviour",
      userValue: "Value",
      happyPath: ["do it"],
      acceptanceCriteria: [{ id: "US-QRO-001-AC-01", given: "g", when: "w", then: "t" }],
      expectedResults: ["done"],
      serviceIds: ["svc"],
      confirmedBehavior: false,
    }).state;
    state = verify(state, [scenario(`${REQ}-AC-01`, "PASS"), scenario(`${REQ}-AC-02`, "PASS")]).state;
    const evidence = requirementEvidence(state, REQ);
    expect(evidence.status === "executed" && evidence.verdict).toBe("PASS_WITH_RISKS");
    expect(evidence.status === "executed" && evidence.reasons).toContain("story-not-verified:US-QRO-001@1");
  });

  it("evidence for a superseded requirement does not count", () => {
    const state = verify(base(), [scenario(`${REQ}-AC-01`, "PASS"), scenario(`${REQ}-AC-02`, "PASS")]).state;
    const superseded = {
      ...state,
      requirements: state.requirements.map((r) => ({ ...r, status: "superseded" as const })),
    };
    expect(requirementEvidence(superseded, REQ).status).toBe("missing");
  });
});
