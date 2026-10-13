import { describe, expect, it } from "vitest";
import {
  applyWorkflowCommand,
  BULK_IMPORT_REQUIREMENTS,
  addRequirement,
  classifyClarification,
  classifyJiraFailure,
  createHandoff,
  diagnoseCompatibility,
  evaluateRequirementBehavior,
  featureReadiness,
  openLocalWorkflow,
  questionsToAsk,
  redactPersistent,
  resumeWorkflow,
  returnFinding,
  reviseRequirement,
  routeCapabilities,
  transition,
  WorkflowError,
  type Capability,
  type Service,
  type WorkflowState,
} from "./workflow.js";

function bulkState(): WorkflowState {
  let state = openLocalWorkflow({
    projectId: "PRJ-LOCAL",
    title: "Bulk User Import",
    request: "I need to implement bulk user import from CSV in our application.",
  });
  for (const req of BULK_IMPORT_REQUIREMENTS) state = addRequirement(state, req);
  const services: Service[] = [
    {
      id: "frontend",
      name: "Admin UI",
      kind: "frontend",
      repository: "admin-web",
      responsibilities: ["upload", "preview", "progress"],
      requirementIds: ["REQ-BUI-002", "REQ-BUI-003"],
      dependsOn: ["api"],
      status: "in_progress",
    },
    {
      id: "api",
      name: "Import API",
      kind: "api",
      repository: "import-api",
      responsibilities: ["authorization", "accept file"],
      requirementIds: ["REQ-BUI-001", "REQ-BUI-002", "REQ-BUI-003"],
      dependsOn: [],
      status: "approved",
    },
    {
      id: "worker",
      name: "Import worker",
      kind: "worker",
      repository: "import-worker",
      responsibilities: ["partial success", "retry"],
      requirementIds: ["REQ-BUI-001", "REQ-BUI-003", "REQ-BUI-004"],
      dependsOn: ["api", "identity"],
      status: "blocked",
    },
    {
      id: "identity",
      name: "User persistence",
      kind: "persistence",
      repository: "identity",
      responsibilities: ["idempotent user create"],
      requirementIds: ["REQ-BUI-001", "REQ-BUI-004"],
      dependsOn: [],
      status: "in_progress",
    },
  ];
  return { ...state, services };
}

const readCap: Capability = {
  id: "cap.architect.security",
  plugin: "praxis-architect",
  description: "Security architecture guidance",
  intents: ["security", "authentication"],
  stages: ["in_progress"],
  roles: ["developer", "architect"],
  inputs: ["request"],
  outputs: ["guidance"],
  dependencies: [],
  sideEffect: "read",
  activation: "guidance",
  version: "1",
  installed: true,
};

describe("local workflow without Jira", () => {
  it("keeps a stable work item id and does not require a Jira key", () => {
    const state = bulkState();
    expect(state.workItem.jiraIssueKey).toBeUndefined();
    expect(state.workItem.id).toBe("WI-BULK-USER-IMPORT-001");
    expect(state.requirements.map((r) => r.id)).toEqual([
      "REQ-BUI-001",
      "REQ-BUI-002",
      "REQ-BUI-003",
      "REQ-BUI-004",
    ]);
  });

  it("associates a Jira key without changing identity", () => {
    const state = openLocalWorkflow({
      projectId: "PRJ",
      title: "Bulk User Import",
      source: "jira",
      jiraIssueKey: "PRX-5",
      request: "Epic PRX-5",
    });
    expect(state.workItem.id).toBe("WI-BULK-USER-IMPORT-001");
    expect(state.workItem.jiraIssueKey).toBe("PRX-5");
  });

  it("hands off forward and resumes without a duplicate", () => {
    let state = bulkState();
    const first = createHandoff(state, {
      sourceRole: "ba",
      targetRole: "architect",
      serviceIds: ["api", "worker", "frontend", "identity"],
      requirementIds: ["REQ-BUI-001"],
      acceptanceCriterionIds: ["REQ-BUI-001-AC-01"],
      artifactRefs: [],
      decisions: [],
      assumptions: ["CSV is UTF-8"],
      openQuestions: [],
      risks: [],
      blockers: [],
      nextActions: ["Design partial-success import"],
      readiness: "ready",
      evidenceRefs: [],
    });
    const again = createHandoff(first.state, {
      sourceRole: "ba",
      targetRole: "architect",
      serviceIds: ["api", "worker", "frontend", "identity"],
      requirementIds: ["REQ-BUI-001"],
      acceptanceCriterionIds: ["REQ-BUI-001-AC-01"],
      artifactRefs: [],
      decisions: [],
      assumptions: ["CSV is UTF-8"],
      openQuestions: [],
      risks: [],
      blockers: [],
      nextActions: ["Design partial-success import"],
      readiness: "ready",
      evidenceRefs: [],
    });
    expect(again.duplicate).toBe(true);
    expect(again.state.handoffs).toHaveLength(1);
    const resumed = resumeWorkflow(again.state);
    expect(resumed.nextRole).toBe("architect");
    expect(resumed.requirementIds).toContain("REQ-BUI-001");
    expect(resumed.duplicateHandoff).toBe(false);
    state = again.state;
    expect(state.workItem.id).toBe("WI-BULK-USER-IMPORT-001");
  });
});

describe("quality independence", () => {
  it("fails all-or-nothing behavior even when tests are green", () => {
    const result = evaluateRequirementBehavior({
      requirementId: "REQ-BUI-001",
      statement: BULK_IMPORT_REQUIREMENTS[0]!.statement,
      observedBehavior: "all-or-nothing",
      testsGreen: true,
      developerClaimsPass: true,
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.finding?.requirementIds).toEqual(["REQ-BUI-001"]);
    expect(result.finding?.owner).toBe("developer");
    const state = bulkState();
    const returned = returnFinding(state, result.finding!);
    expect(returned.handoff.targetRole).toBe("developer");
    expect(returned.handoff.sourceRole).toBe("quality");
    expect(returned.state.findings[0]?.status).toBe("open");
  });

  it("does not treat a service pass as a feature pass", () => {
    const readiness = featureReadiness(bulkState());
    expect(readiness.serviceStatus.api).toBe("approved");
    expect(readiness.ready).toBe(false);
    expect(readiness.missingIntegration).toContain("worker");
  });
});

describe("backward handoff and impact", () => {
  it("returns an ambiguous role decision to BA and stale-marks verdicts", () => {
    let state = addRequirement(openLocalWorkflow({
      projectId: "PRJ",
      title: "Role assignment",
      request: "Assign roles from the CSV.",
    }), {
      id: "REQ-BUI-010",
      statement: "The CSV role column assigns a product role.",
      acceptanceCriteria: ["Unknown roles are rejected."],
    });
    const ask = questionsToAsk([
      {
        id: "q-role",
        prompt: "Which product roles may be assigned from the CSV?",
        changesBehavior: true,
        safeAssumption: false,
      },
      {
        id: "q-known",
        prompt: "Is the file CSV?",
        alreadyKnown: true,
      },
    ]);
    expect(ask.map((q) => q.id)).toEqual(["q-role"]);
    expect(classifyClarification({ alreadyKnown: true }).ask).toBe(false);
    const back = createHandoff(state, {
      sourceRole: "architect",
      targetRole: "ba",
      serviceIds: [],
      requirementIds: ["REQ-BUI-010"],
      acceptanceCriterionIds: [],
      artifactRefs: [],
      decisions: [],
      assumptions: [],
      openQuestions: ["Which product roles may be assigned?"],
      risks: [],
      blockers: ["Role catalog is a business decision"],
      nextActions: ["Record the allowed roles"],
      readiness: "blocked",
      evidenceRefs: [],
    });
    expect(back.handoff.targetRole).toBe("ba");
    state = reviseRequirement(
      {
        ...back.state,
        verdicts: [
          {
            id: "V1",
            scope: "requirement",
            scopeId: "REQ-BUI-010",
            verdict: "PASS",
            evidenceRefs: ["old"],
            requirementIds: ["REQ-BUI-010"],
            stale: false,
          },
        ],
      },
      "REQ-BUI-010",
      "Only Admin and Member may be assigned from the CSV.",
    );
    expect(state.requirements[0]?.revision).toBe(2);
    expect(state.requirements[0]?.id).toBe("REQ-BUI-010");
    expect(state.verdicts[0]?.stale).toBe(true);
  });
});

describe("capabilities, Jira failure, compatibility", () => {
  it("suggests installed guidance and does not execute mutations", () => {
    const routed = routeCapabilities({
      request: "Developer needs authentication security architecture",
      role: "developer",
      stage: "in_progress",
      capabilities: [
        readCap,
        {
          ...readCap,
          id: "cap.jira.write",
          intents: ["security"],
          sideEffect: "external_mutate",
          activation: "explicit",
        },
        { ...readCap, id: "cap.missing", installed: false, intents: ["security"] },
      ],
    });
    expect(routed.guidance.map((c) => c.id)).toEqual(["cap.architect.security"]);
    expect(routed.suggested.map((c) => c.id)).toEqual(["cap.jira.write"]);
    expect(routed.executed).toEqual([]);
  });

  it("keeps local work usable when Jira fails", () => {
    for (const kind of ["not_configured", "invalid_credentials", "network", "conflict"] as const) {
      const failure = classifyJiraFailure(kind);
      expect(failure.localWorkUsable).toBe(true);
      expect(failure.overwriteExternal).toBe(false);
    }
    expect(classifyJiraFailure("conflict").retryable).toBe(false);
    expect(classifyJiraFailure("network").retryable).toBe(true);
  });

  it("diagnoses incompatible inputs explicitly", () => {
    expect(diagnoseCompatibility({ missingPlugin: "praxis-quality" })).toMatchObject({
      ok: false,
      code: "PLUGIN_MISSING",
    });
    expect(
      diagnoseCompatibility({ handoff: { contract: "nope" } }),
    ).toMatchObject({ ok: false, code: "HANDOFF_SCHEMA_INVALID" });
    expect(
      diagnoseCompatibility({ artifactPath: "wp/missing.json", artifactExists: false }),
    ).toMatchObject({ ok: false, code: "ARTIFACT_MISSING" });
    expect(diagnoseCompatibility({ command: "" })).toMatchObject({
      ok: false,
      code: "COMMAND_UNRESOLVED",
    });
  });

  it("applies a local command stream and rejects a repeated handoff", () => {
    let state = null as ReturnType<typeof openLocalWorkflow> | null;
    state = applyWorkflowCommand(state, {
      action: "open",
      projectId: "PRJ-LOCAL",
      title: "Bulk User Import",
      request: "Import users from CSV without Jira",
    }).state;
    state = applyWorkflowCommand(state, {
      action: "add-requirement",
      id: "REQ-BUI-001",
      statement: BULK_IMPORT_REQUIREMENTS[0]!.statement,
      acceptanceCriteria: ["Valid rows import when other rows are invalid."],
    }).state;
    const handoff = {
      action: "handoff" as const,
      sourceRole: "ba" as const,
      targetRole: "architect" as const,
      requirementIds: ["REQ-BUI-001" as const],
      readiness: "ready" as const,
    };
    const once = applyWorkflowCommand(state, handoff);
    const twice = applyWorkflowCommand(once.state, handoff);
    expect(twice.duplicate).toBe(true);
    expect(twice.state.handoffs).toHaveLength(1);
    const quality = applyWorkflowCommand(twice.state, {
      action: "quality-check",
      requirementId: "REQ-BUI-001",
      observedBehavior: "all-or-nothing",
      testsGreen: true,
      developerClaimsPass: true,
    });
    expect(quality.result).toMatchObject({ verdict: "FAIL" });
    expect(quality.state.workItem.jiraIssueKey).toBeUndefined();
  });

  it("redacts secrets and rejects illegal transitions", () => {
    expect(redactPersistent({ jira_token: "super-secret-value", note: "ok" })).toEqual({
      jira_token: "[redacted]",
      note: "ok",
    });
    const state = openLocalWorkflow({ projectId: "P", title: "T", request: "r" });
    expect(() => transition(state, "completed", "skip")).toThrow(WorkflowError);
  });
});
