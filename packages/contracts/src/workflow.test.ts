import { describe, expect, it } from "vitest";
import { rollupStoryVerdict } from "./story.js";
import { approvalFor } from "./human-act-testing.js";
import {
  applyWorkflowCommand,
  BULK_IMPORT_REQUIREMENTS,
  addRequirement,
  classifyClarification,
  classifyJiraFailure,
  createHandoff,
  decisionContentFingerprint,
  diagnoseCompatibility,
  evaluateFeature,
  evaluateRequirementBehavior,
  inspectImportImplementation,
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

  it("never reports ready while an integration is missing (ready and missingIntegration agree)", () => {
    const done = (id: string, dependsOn: string[]) => ({
      id, name: id, kind: "module" as const, responsibilities: ["x"], requirementIds: [], dependsOn, status: "approved" as const,
    });
    const state = { ...bulkState(), services: [done("api", []), done("worker", ["queue"])] };
    const readiness = featureReadiness(state);
    // Every listed service is approved, but worker depends on "queue", which no service provides.
    expect(readiness.missingIntegration).toEqual(["worker"]);
    expect(readiness.unknownDependencies).toEqual(["queue"]);
    expect(readiness.ready).toBe(false);
    const gaps = evaluateFeature(state).gaps;
    expect(gaps).toContain("unknown dependency: queue");
    expect(gaps).not.toContain("services are not approved");
    // And the clean case still reports ready with nothing missing.
    const clean = featureReadiness({ ...bulkState(), services: [done("api", []), done("worker", ["api"])] });
    expect(clean).toMatchObject({ ready: true, missingIntegration: [], unknownDependencies: [] });
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
    expect(redactPersistent({ commitSha: "4c7270ce0b4ec1c0353342b9ae32d996c16c47b4" })).toEqual({
      commitSha: "4c7270ce0b4ec1c0353342b9ae32d996c16c47b4",
    });
    const state = openLocalWorkflow({ projectId: "P", title: "T", request: "r" });
    expect(() => transition(state, "completed", "skip")).toThrow(WorkflowError);
  });

  it("inspects implementation source and ignores a contradictory claim", () => {
    const defective = `
      export async function importRows(db, rows) {
        await db.transaction(async (tx) => {
          for (const row of rows) {
            if (row.invalid) throw new Error("abort");
            await tx.insert(row);
          }
        });
      }
    `;
    const partial = `
      export async function importRows(db, rows) {
        for (const row of rows) {
          if (row.invalid) continue;
          await db.insert(row);
        }
      }
    `;
    expect(inspectImportImplementation(defective)).toBe("all-or-nothing");
    expect(inspectImportImplementation(partial)).toBe("partial-success");
    const statement =
      "Invalid, duplicate or failed rows never prevent valid rows from being created. The import is not all-or-nothing; each row has its own outcome.";
    let state = applyWorkflowCommand(null, {
      action: "open",
      projectId: "PRJ",
      title: "Bulk User Import",
      request: "Import users from CSV",
    }).state;
    state = applyWorkflowCommand(state, {
      action: "add-requirement",
      id: "REQ-BUI-061",
      statement,
      acceptanceCriteria: ["AC-BUI-061: 950 valid rows are created when 50 rows are invalid."],
      serviceIds: ["worker"],
    }).state;
    const failed = applyWorkflowCommand(state, {
      action: "quality-check",
      requirementId: "REQ-BUI-061",
      implementationSource: defective,
      observedBehavior: "partial-success",
      testsGreen: true,
      developerClaimsPass: true,
      serviceId: "worker",
    });
    expect(failed.result).toMatchObject({
      verdict: "FAIL",
      observedBehavior: "all-or-nothing",
    });
    expect(JSON.stringify(failed.result)).toContain("unsupported-claim:partial-success");
    const passed = applyWorkflowCommand(failed.state, {
      action: "quality-check",
      requirementId: "REQ-BUI-061",
      implementationSource: partial,
      serviceId: "worker",
    });
    expect(passed.result).toMatchObject({ verdict: "PASS", observedBehavior: "partial-success" });
  });

  it("asks only blocking questions and keeps other requirements moving", () => {
    let state = applyWorkflowCommand(null, {
      action: "open",
      projectId: "PRJ",
      title: "Bulk User Import",
      request: "Import users from CSV",
    }).state;
    const clarified = applyWorkflowCommand(state, {
      action: "clarify",
      role: "ba",
      known: ["columns are email, name, and role"],
      questions: [
        {
          id: "Q-COLUMNS",
          prompt: "Which columns does the CSV contain?",
          alreadyKnown: true,
        },
        {
          id: "Q-ROLES",
          prompt: "Which product roles may appear in the role column?",
          changesBehavior: true,
        },
        {
          id: "Q-RETRY",
          prompt: "How many automatic retries?",
          safeAssumption: true,
          assumption: "A failed row is retried by the platform default before it is marked FAILED.",
        },
      ],
    });
    expect(clarified.result).toMatchObject({
      questions: [{ id: "Q-ROLES" }],
    });
    expect(clarified.state.assumptions.map((item) => item.id)).toEqual(["A-Q-RETRY"]);
    state = applyWorkflowCommand(clarified.state, {
      action: "add-requirement",
      id: "REQ-BUI-063",
      statement: "Each data row ends with exactly one final outcome.",
      acceptanceCriteria: ["No completed row remains PENDING."],
    }).state;
    expect(state.requirements.map((item) => item.id)).toEqual(["REQ-BUI-063"]);
    state = applyWorkflowCommand(state, {
      action: "record-decision",
      id: "ADR-ROLES",
      statement: "The role column accepts organization admin and member.",
    }).state;
    // Recorded, not confirmed: the stage does not advance on an agent's say-so.
    expect(state.stage).not.toBe("ready");
    {
      const decision = state.decisions.find((item) => item.id === "ADR-ROLES")!;
      const confirm = { action: "confirm-decision" as const, id: "ADR-ROLES", revision: decision.revision, contentFingerprint: decisionContentFingerprint(decision) };
      expect(() => applyWorkflowCommand(state, confirm)).toThrow(/needs the user's approval/);
      state = applyWorkflowCommand(state, confirm, approvalFor(state, confirm)).state;
    }
    expect(state.decisions.find((item) => item.id === "ADR-ROLES")?.confirmed).toBe(true);
    expect(state.stage).toBe("ready");
    state = applyWorkflowCommand(state, {
      action: "record-implementation",
      id: "IMPL-WORKER",
      serviceId: "worker",
      requirementIds: ["REQ-BUI-063"],
      path: "src/import-rows.js",
      summary: "Per-row outcomes",
      contractRef: "row-outcome",
    }).state;
    state = applyWorkflowCommand(state, {
      action: "revise-requirement",
      id: "REQ-BUI-063",
      statement: "Each data row ends with exactly one final outcome, including FAILED.",
    }).state;
    expect(state.implementationUnits[0]?.stale).toBe(true);
    const feature = evaluateFeature(state);
    expect(feature.verdict).toBe("FAIL");
    expect(feature.gaps.join(" ")).toContain("REQ-BUI-063");
  });

  it("stores a user story and refuses to treat a missing happy path as pass", () => {
    let state = applyWorkflowCommand(null, {
      action: "open",
      projectId: "PRJ",
      title: "Bulk User Import",
      request: "Import users from CSV",
    }).state;
    state = applyWorkflowCommand(state, {
      action: "add-requirement",
      id: "REQ-BUI-061",
      statement: "Invalid rows never prevent valid rows from being created.",
      acceptanceCriteria: ["AC-BUI-061 valid rows are created."],
    }).state;
    state = applyWorkflowCommand(state, {
      action: "add-story",
      id: "US-BUI-001",
      requirementIds: ["REQ-BUI-061"],
      actor: "organization admin",
      narrative: "As a organization admin, I want to import users from a CSV, so that I can onboard them without manual entry.",
      objective: "Create valid users from a CSV",
      userValue: "Faster onboarding",
      happyPath: ["Upload a valid CSV", "Confirm the import", "See the created users"],
      acceptanceCriteria: [
        {
          id: "US-BUI-001-AC-01",
          given: "an organization admin and a valid CSV",
          when: "the admin confirms the import",
          then: "the valid users are created and the summary is shown",
        },
      ],
      expectedResults: ["Users exist and the summary says completed"],
      serviceIds: ["api", "frontend"],
      confirmedBehavior: false,
    }).state;
    expect(state.stories[0]?.confirmedBehavior).toBe(false);
    state = applyWorkflowCommand(state, {
      action: "set-service",
      service: {
        id: "api",
        name: "API",
        kind: "api",
        localPath: "/tmp/api",
        responsibilities: ["preview"],
        requirementIds: ["REQ-BUI-061"],
        dependsOn: [],
        status: "in_progress",
      },
    }).state;
    const located = applyWorkflowCommand(state, { action: "locate-repositories" });
    expect(located.result).toEqual({
      questions: [
        {
          id: "Q-REPO-FRONTEND",
          prompt:
            "This feature affects frontend. I need the local path or repository URL for frontend to complete end-to-end verification.",
        },
      ],
    });
    const handed = applyWorkflowCommand(state, {
      action: "handoff",
      sourceRole: "ba",
      targetRole: "architect",
      requirementIds: ["REQ-BUI-061"],
      serviceIds: ["api", "frontend"],
      readiness: "ready",
    });
    expect(handed.state.handoffs[0]?.storyIds).toEqual(["US-BUI-001"]);
    expect(() =>
      applyWorkflowCommand(state, { action: "verify-stories" }),
    ).toThrow(/must run in Praxis Runtime/);
    expect(
      rollupStoryVerdict([
        {
          storyId: "US-BUI-001",
          requirementId: "REQ-BUI-061",
          acceptanceCriterionId: "US-BUI-001-AC-01",
          scenarioId: "US-BUI-001-HAPPY",
          kind: "happy",
          serviceId: "frontend",
          repository: "",
          implementationPath: "",
          testRef: "",
          evidence: ["missing"],
          status: "NOT_VERIFIED",
          critical: true,
        },
      ]).verdict,
    ).toBe("FAIL");
  });
});
