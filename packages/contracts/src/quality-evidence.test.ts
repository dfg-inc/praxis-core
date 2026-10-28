import { describe, expect, it } from "vitest";
import {
  applyWorkflowCommand,
  approvalFor,
  openLocalWorkflow,
  requirementEvidence,
  storyContentFingerprint,
  type WorkflowState,
} from "./index.js";

const REQ = "REQ-QEV-901" as const;

function storyCommand(id: string) {
  return {
    action: "add-story" as const,
    id,
    requirementIds: [REQ],
    actor: "operator",
    narrative: "As a operator, I want blank settings unset, so that doctor is accurate.",
    objective: "Blank settings are unset",
    userValue: "Accurate diagnostics",
    happyPath: ["Scrub placeholders"],
    acceptanceCriteria: [{ id: `${id}-AC-01`, given: "a placeholder", when: "scrubbed", then: "removed" }],
    expectedResults: ["Removed"],
    serviceIds: ["svc"],
    confirmedBehavior: false,
  };
}

function scenario(storyId: string, status: "PASS" | "FAIL", scenarioId = `${storyId}-S1`) {
  return {
    storyId,
    requirementId: REQ,
    acceptanceCriterionId: `${REQ}-AC-01`,
    scenarioId,
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

function base(): WorkflowState {
  let state = openLocalWorkflow({ mode: "classic", projectId: "qev", title: "Evidence", request: "Evidence consistency" });
  state = applyWorkflowCommand(state, {
    action: "add-requirement",
    id: REQ,
    statement: "Blank Desktop settings are treated as unset.",
    acceptanceCriteria: ["Placeholders are removed."],
  }).state;
  return applyWorkflowCommand(state, storyCommand("US-QEV-901")).state;
}

function verify(state: WorkflowState, scenarios: ReturnType<typeof scenario>[]) {
  return applyWorkflowCommand(state, { action: "record-verification", independentRerun: true, scenarios }, { evidenceSource: { kind: "executed", artifacts: [] } });
}

function qualityCheck(state: WorkflowState) {
  return applyWorkflowCommand(state, { action: "quality-check", requirementId: REQ, testsGreen: true });
}

function requirementVerdicts(state: WorkflowState) {
  return state.verdicts.filter((verdict) => verdict.scope === "requirement" && verdict.scopeId === REQ);
}

describe("requirement evidence shared by verify-stories and quality-check", () => {
  it("regression: executed PASS coverage is not reported as missing evidence", () => {
    const verified = verify(base(), [scenario("US-QEV-901", "PASS")]).state;
    // Original defect: quality-check ignored coverage, raised F-<req>-evidence and returned work to Developer.
    const checked = qualityCheck(verified);
    const result = checked.result as { verdict: string; evidenceStatus: string; finding: unknown };
    expect(result.evidenceStatus).toBe("executed");
    expect(result.finding).toBeNull();
    expect(result.verdict).toBe("PASS_WITH_RISKS");
    expect(checked.state.findings.some((f) => f.id === `F-${REQ}-evidence`)).toBe(false);
    expect(checked.state.stage).not.toBe("changes_requested");
    const latest = requirementVerdicts(checked.state).at(-1)!;
    expect(latest.evidenceRefs).toContain("story-unconfirmed:US-QEV-901@1");
    expect(latest.evidenceRefs).not.toContain("missing independent evidence");
  });

  it("verify-stories records a requirement verdict with story provenance", () => {
    const verified = verify(base(), [scenario("US-QEV-901", "PASS")]).state;
    const [verdict] = requirementVerdicts(verified);
    expect(verdict?.verdict).toBe("PASS_WITH_RISKS");
    expect(verdict?.evidenceRefs).toEqual(
      expect.arrayContaining(["story:US-QEV-901@1", "US-QEV-901-S1:PASS", "story-unconfirmed:US-QEV-901@1"]),
    );
    expect(verified.coverage.find((entry) => entry.scenarioId === "US-QEV-901-S1")?.storyRevision).toBe(1);
  });

  it("without executed coverage quality-check still reports missing evidence", () => {
    const checked = qualityCheck(base());
    const result = checked.result as { verdict: string; evidenceStatus: string; finding: { id: string } | null };
    expect(result.evidenceStatus).toBe("missing");
    expect(result.verdict).toBe("PASS_WITH_RISKS");
    expect(result.finding?.id).toBe(`F-${REQ}-evidence`);
  });

  it("a failing scenario yields FAIL and a Developer finding", () => {
    const verified = verify(base(), [scenario("US-QEV-901", "PASS"), scenario("US-QEV-901", "FAIL", "US-QEV-901-S2")]).state;
    expect(requirementVerdicts(verified).at(-1)?.verdict).toBe("FAIL");
    const checked = qualityCheck(verified);
    const result = checked.result as { verdict: string; finding: { id: string; owner: string } | null };
    expect(result.verdict).toBe("FAIL");
    expect(result.finding).toMatchObject({ id: `F-${REQ}-coverage`, owner: "developer" });
  });

  it("coverage of an older story revision is not evidence for the current revision", () => {
    const verified = verify(base(), [scenario("US-QEV-901", "PASS")]).state;
    const revised: WorkflowState = {
      ...verified,
      stories: verified.stories.map((story) => ({ ...story, revision: 2 })),
    };
    expect(requirementEvidence(revised, REQ).status).toBe("missing");
  });

  it("a second linked story without coverage keeps the verdict below PASS", () => {
    let state = applyWorkflowCommand(base(), storyCommand("US-QEV-902")).state;
    state = verify(state, [scenario("US-QEV-901", "PASS")]).state;
    const evidence = requirementEvidence(state, REQ);
    expect(evidence.status === "executed" && evidence.verdict).toBe("PASS_WITH_RISKS");
    expect(evidence.status === "executed" && evidence.reasons).toContain("story-not-verified:US-QEV-902@1");
  });

  it("PASS only when every linked story is confirmed and all scenarios pass", () => {
    const state = base();
    const target = state.stories[0]!;
    const command = { action: "confirm-story" as const, id: target.id, revision: target.revision, contentFingerprint: storyContentFingerprint(target) };
    const confirmed = applyWorkflowCommand(state, command, approvalFor(state, command)).state;
    const verified = verify(confirmed, [scenario("US-QEV-901", "PASS")]).state;
    expect(requirementVerdicts(verified).at(-1)?.verdict).toBe("PASS");
    expect((qualityCheck(verified).result as { verdict: string }).verdict).toBe("PASS");
  });
});
