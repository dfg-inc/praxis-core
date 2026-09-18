import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
  LOCALIZED_RU_TRANSITIONS,
} from "../src/rest-provider.js";
import {
  assertNumericTransitionId,
  JiraTransitionError,
  parseNumericTransitionId,
  resolveSemanticTransition,
  type TransitionInfo,
} from "../src/transitions.js";
import { architectPlanEpic, baAnalyzeEpic, claimWorkPackage, loadJournal } from "../src/workflows.js";
import type { JiraConfig } from "../src/config.js";

function cfg(transitions: Record<string, string> = {}): JiraConfig {
  return {
    mode: "cloud",
    baseUrl: "https://acme.atlassian.net",
    token: "tok",
    projectKey: "PRX",
    email: "dev@example.com",
    authMode: "cloud-basic",
    epicType: "Epic",
    storyType: "Story",
    taskType: "Task",
    bugType: "Bug",
    workPackageType: "",
    transitions,
    workPackageMaxHours: 16,
  };
}

function seedCanonicalWp(repo: string, id = "WP-20260914-002") {
  const dir = join(repo, "design", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), "reset() returns the counter to zero.\n");
  writeFileSync(
    join(dir, "change-spec.json"),
    `${JSON.stringify({ id, files: ["src/counter.js"], design: { title: "Add reset() to the counter library" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "architect-developer.handoff.json"),
    `${JSON.stringify({ contract: "architect.developer.handoff", version: "1.0.0", workPackageId: id }, null, 2)}\n`,
  );
}

async function seedReadyWp(opts?: {
  availableTransitions?: typeof LOCALIZED_RU_TRANSITIONS;
  transitionPostStatus?: number;
  transitions?: Record<string, string>;
}) {
  const state = createMockJiraState({
    availableTransitions: opts?.availableTransitions,
    transitionPostStatus: opts?.transitionPostStatus,
  });
  const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
  const provider = createJiraProvider({ config: cfg(opts?.transitions), fetchImpl });
  const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
  const repo = mkdtempSync(join(tmpdir(), "praxis-claim-"));
  await baAnalyzeEpic({
    provider,
    epicKey: epic.key,
    repo,
    stories: [
      {
        logicalId: "E2-FR1",
        summary: "Counter library: add reset() to return the counter to zero",
        userStory: "As a developer I want reset So that I can zero the counter",
        acceptanceCriteria: "Given a counter When reset Then value is 0",
        requirementIds: ["E2-FR1"],
      },
    ],
  });
  seedCanonicalWp(repo);
  const { workPackages } = await architectPlanEpic({ provider, epicKey: epic.key, repo });
  const wpKey = workPackages[0]!.jiraIssueKey;
  return { provider, state, repo, wpKey };
}

const englishAvailable: TransitionInfo[] = [
  {
    id: "21",
    name: "Start Progress",
    toStatus: "In Progress",
    toStatusCategory: "indeterminate",
  },
];

const russianAvailable: TransitionInfo[] = [
  {
    id: "21",
    name: "В работу",
    toStatus: "В работе",
    toStatusCategory: "indeterminate",
  },
];

describe("transition id validation", () => {
  it("accepts numeric strings and integers", () => {
    expect(parseNumericTransitionId("21")).toBe("21");
    expect(parseNumericTransitionId(21)).toBe("21");
    expect(parseNumericTransitionId("In Progress")).toBeUndefined();
    expect(parseNumericTransitionId("Start Progress")).toBeUndefined();
    expect(parseNumericTransitionId("В работу")).toBeUndefined();
  });

  it("rejects non-numeric values before any POST", () => {
    expect(() =>
      assertNumericTransitionId("In Progress", {
        issueKey: "PRX-4",
        semanticAction: "START_DEVELOPMENT",
      }),
    ).toThrow(/JIRA_TRANSITION_ID_INVALID/);
  });
});

describe("semantic START_DEVELOPMENT resolution", () => {
  it("resolves by target status category, not English name", () => {
    const hit = resolveSemanticTransition({
      semantic: "START_DEVELOPMENT",
      available: russianAvailable,
      issueKey: "PRX-4",
      currentStatus: "К выполнению",
      currentStatusCategory: "new",
    });
    expect(hit.id).toBe("21");
    expect(hit.alreadySatisfied).toBe(false);
  });

  it("resolves English labels the same way", () => {
    const hit = resolveSemanticTransition({
      semantic: "START_DEVELOPMENT",
      available: englishAvailable,
      issueKey: "PRX-4",
      currentStatus: "To Do",
      currentStatusCategory: "new",
    });
    expect(hit.id).toBe("21");
  });

  it("treats current indeterminate status as already satisfied", () => {
    const hit = resolveSemanticTransition({
      semantic: "START_DEVELOPMENT",
      available: [],
      issueKey: "PRX-4",
      currentStatus: "В работе",
      currentStatusCategory: "indeterminate",
    });
    expect(hit.alreadySatisfied).toBe(true);
  });

  it("does not guess when no development transition exists", () => {
    expect(() =>
      resolveSemanticTransition({
        semantic: "START_DEVELOPMENT",
        available: [
          { id: "31", name: "Готово", toStatus: "Готово", toStatusCategory: "done" },
        ],
        issueKey: "PRX-4",
        currentStatus: "К выполнению",
        currentStatusCategory: "new",
      }),
    ).toThrow(/JIRA_TRANSITION_NOT_AVAILABLE/);
  });

  it("rejects configured non-numeric mapping ids", () => {
    expect(() =>
      resolveSemanticTransition({
        semantic: "START_DEVELOPMENT",
        available: englishAvailable,
        mapping: { "in-progress": "In Progress" },
        issueKey: "PRX-4",
        currentStatus: "To Do",
        currentStatusCategory: "new",
      }),
    ).toThrow(/JIRA_TRANSITION_ID_INVALID/);
  });
});

describe("claimWorkPackage transitions", () => {
  it("POSTs the discovered numeric id, not a status name", async () => {
    const { provider, state, repo, wpKey } = await seedReadyWp();
    const claim = await claimWorkPackage({
      provider,
      wpKey,
      repo,
      actor: "dev-a",
      accountId: "acct-a",
    });
    expect(claim.state).toBe("active");
    expect(state.transitionPosts.length).toBeGreaterThan(0);
    for (const post of state.transitionPosts) {
      const body = post.body as { id?: unknown; name?: unknown };
      expect(body.name).toBeUndefined();
      expect(parseNumericTransitionId(body.id)).toBe(String(body.id));
    }
    expect(state.transitionPosts.some((p) => (p.body as { id?: string }).id === "21")).toBe(
      true,
    );
  });

  it("resolves a localized development-start transition", async () => {
    const { provider, state, repo, wpKey } = await seedReadyWp({
      availableTransitions: LOCALIZED_RU_TRANSITIONS,
    });
    await claimWorkPackage({
      provider,
      wpKey,
      repo,
      actor: "dev-a",
      accountId: "acct-a",
    });
    expect(state.transitionPosts.some((p) => (p.body as { id?: string }).id === "21")).toBe(
      true,
    );
    const issue = await provider.getIssue(wpKey);
    expect(issue.statusCategory).toBe("indeterminate");
  });

  it("skips transition when already in development status", async () => {
    const { provider, state, repo, wpKey } = await seedReadyWp({
      availableTransitions: [
        {
          id: "31",
          name: "Готово",
          to: { name: "Готово", statusCategory: { key: "done" } },
        },
      ],
    });
    for (const issue of state.issues.values()) {
      if (issue.issueType === "Epic") continue;
      issue.status = "В работе";
      issue.statusCategory = "indeterminate";
    }
    const before = state.transitionPosts.length;
    const claim = await claimWorkPackage({
      provider,
      wpKey,
      repo,
      actor: "dev-a",
      accountId: "acct-a",
    });
    expect(claim.state).toBe("active");
    expect(state.transitionPosts.length).toBe(before);
  });

  it("fails closed when no START_DEVELOPMENT transition is available", async () => {
    const { provider, state, repo, wpKey } = await seedReadyWp({
      availableTransitions: [
        {
          id: "31",
          name: "Готово",
          to: { name: "Готово", statusCategory: { key: "done" } },
        },
      ],
    });
    await expect(
      claimWorkPackage({
        provider,
        wpKey,
        repo,
        actor: "dev-a",
        accountId: "acct-a",
      }),
    ).rejects.toMatchObject({ code: "JIRA_TRANSITION_NOT_AVAILABLE" });
    expect(await provider.getIssueProperty(wpKey, "praxis.claim")).toBeUndefined();
    expect(existsSync(join(repo, ".praxis-jira", "claims", `${wpKey}.json`))).toBe(false);
    expect(state.transitionPosts).toEqual([]);
  });

  it("rejects non-numeric transition ids locally before POST", async () => {
    const { provider, state, wpKey } = await seedReadyWp();
    await expect(provider.transitionIssue(wpKey, "In Progress")).rejects.toBeInstanceOf(
      JiraTransitionError,
    );
    await expect(provider.transitionIssue(wpKey, "Start Progress")).rejects.toMatchObject({
      code: "JIRA_TRANSITION_ID_INVALID",
    });
    expect(state.transitionPosts).toEqual([]);
  });

  it("leaves no claim artifacts if the transition POST fails", async () => {
    const { provider, state, repo, wpKey } = await seedReadyWp({
      transitionPostStatus: 400,
    });
    await expect(
      claimWorkPackage({
        provider,
        wpKey,
        repo,
        actor: "dev-a",
        accountId: "acct-a",
      }),
    ).rejects.toThrow();
    expect(await provider.getIssueProperty(wpKey, "praxis.claim")).toBeUndefined();
    const manifest = state.issues.get(wpKey)?.properties["praxis.workPackageManifest"] as
      | { claim?: unknown }
      | undefined;
    expect(manifest?.claim ?? null).toBeNull();
    expect(existsSync(join(repo, ".praxis-jira", "claims", `${wpKey}.json`))).toBe(false);
    expect(
      loadJournal(repo).some(
        (e) => /claim/i.test(e.operationId) || /claim/i.test(e.kind),
      ),
    ).toBe(false);
    const localManifestPath = join(repo, "work-packages", "WP-20260914-002", "manifest.json");
    if (existsSync(localManifestPath)) {
      const local = JSON.parse(readFileSync(localManifestPath, "utf8")) as { claim?: unknown };
      expect(local.claim ?? null).toBeNull();
    }
  });
});
