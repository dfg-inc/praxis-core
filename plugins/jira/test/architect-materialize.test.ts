import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
} from "../src/rest-provider.js";
import { architectPlanEpic, baAnalyzeEpic, claimWorkPackage } from "../src/workflows.js";
import { resolveLocalWorkPackage, resolveRemoteWpKey } from "../src/work-package-local.js";
import type { JiraConfig } from "../src/config.js";

function cfg(): JiraConfig {
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
    transitions: {},
    workPackageMaxHours: 16,
  };
}

function seedWp(repo: string, id = "WP-20260914-002") {
  const dir = join(repo, "design", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), "# Counter Reset\n\nreset() returns the counter to zero.\n");
  writeFileSync(join(dir, "change-spec.json"), `${JSON.stringify({ id }, null, 2)}\n`);
  writeFileSync(
    join(dir, "architect-developer.handoff.json"),
    `${JSON.stringify({ contract: "architect.developer.handoff", version: "1.0.0", workPackageId: id }, null, 2)}\n`,
  );
}

describe("architect materialization", () => {
  it("previews CREATE of canonical WP without generic tech tasks or placeholder mermaid", async () => {
    const state = createMockJiraState();
    const provider = createJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-arch-"));
    await baAnalyzeEpic({
      provider,
      epicKey: epic.key,
      repo,
      stories: [
        {
          logicalId: "E2-FR1",
          summary: "Counter library: add reset()",
          userStory: "As a developer I want reset So that I can zero the counter",
          acceptanceCriteria: "Given a counter When reset Then value is 0",
          requirementIds: ["E2-FR1"],
        },
      ],
    });
    seedWp(repo);
    const before = state.createIssueCount;
    const preview = await architectPlanEpic({
      provider,
      epicKey: epic.key,
      repo,
      dryRun: true,
    });
    expect(state.createIssueCount).toBe(before);
    const plan = preview.plan as Array<{ action: string; kind: string; summary: string }>;
    expect(plan.filter((p) => p.action === "CREATE" && p.kind === "work-package")).toHaveLength(1);
    expect(preview.taskKeys).toEqual([]);
    expect(preview.planText).toMatch(/CREATE TECHNICAL TASKS:\n  none/);
    expect(preview.planText).not.toMatch(/Technical implementation for/);
    expect(preview.planText).not.toMatch(/flowchart LR\s*A-->B/);
    expect(JSON.stringify(preview)).not.toMatch(/wp:PRX-/);
  });

  it("apply creates one Jira WP correlated to WP-20260914-002 and is idempotent", async () => {
    const state = createMockJiraState();
    const provider = createJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-arch-"));
    const ba = await baAnalyzeEpic({
      provider,
      epicKey: epic.key,
      repo,
      stories: [
        {
          logicalId: "E2-FR1",
          summary: "Counter library: add reset()",
          userStory: "As a developer I want reset So that I can zero the counter",
          acceptanceCriteria: "Given When Then",
          requirementIds: ["E2-FR1"],
        },
      ],
    });
    seedWp(repo);
    const first = await architectPlanEpic({ provider, epicKey: epic.key, repo });
    expect(first.workPackages).toHaveLength(1);
    expect(first.workPackages[0]!.id).toBe("WP-20260914-002");
    expect(first.workPackages[0]!.storyKeys).toEqual(ba.storyKeys);
    expect(first.taskKeys).toEqual([]);
    const wpKey = first.workPackages[0]!.jiraIssueKey;
    const issue = await provider.getIssue(wpKey);
    expect(["task", "work-package"]).toContain(issue.semanticType);
    if (issue.semanticType === "task") {
      expect(issue.labels).toContain("praxis-work-package");
    }
    const prop = await provider.getIssueProperty<{ id?: string }>(wpKey, "praxis.workPackage");
    expect(prop).toMatchObject({ id: "WP-20260914-002" });
    const manifest = JSON.parse(
      readFileSync(join(repo, "work-packages", "WP-20260914-002", "manifest.json"), "utf8"),
    );
    expect(manifest.jiraIssueKey).toBe(wpKey);
    const comments = await provider.getComments(ba.storyKeys[0]!);
    expect(comments).toHaveLength(1);
    const before = state.createIssueCount;
    const second = await architectPlanEpic({ provider, epicKey: epic.key, repo });
    expect(state.createIssueCount).toBe(before);
    expect(second.workPackages[0]!.jiraIssueKey).toBe(wpKey);
    const comments2 = await provider.getComments(ba.storyKeys[0]!);
    expect(comments2).toHaveLength(1);
    const local = resolveLocalWorkPackage(repo, wpKey);
    expect(local?.id).toBe("WP-20260914-002");
    expect(resolveRemoteWpKey(repo, "WP-20260914-002")).toBe(wpKey);
    const claim = await claimWorkPackage({
      provider,
      wpKey: "WP-20260914-002",
      repo,
      actor: "dev-a",
      accountId: "acct-a",
    });
    expect(claim.jiraWorkPackageKey).toBe(wpKey);
  });

  it("does not create a parallel wp:PRX-3 identity", async () => {
    const state = createMockJiraState();
    const provider = createJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-arch-"));
    await baAnalyzeEpic({
      provider,
      epicKey: epic.key,
      repo,
      stories: [
        {
          logicalId: "E2-FR1",
          summary: "s",
          userStory: "As a user I want x So that y",
          acceptanceCriteria: "Given When Then",
          requirementIds: ["E2-FR1"],
        },
      ],
    });
    seedWp(repo);
    mkdirSync(join(repo, "work-packages", "wp:PRX-3"), { recursive: true });
    writeFileSync(
      join(repo, "work-packages", "wp:PRX-3", "manifest.json"),
      `${JSON.stringify({ id: "wp:PRX-3" }, null, 2)}\n`,
    );
    const plan = await architectPlanEpic({ provider, epicKey: epic.key, repo });
    expect(plan.workPackages.map((w) => w.id)).toEqual(["WP-20260914-002"]);
    expect(plan.workPackages[0]!.id).not.toBe("wp:PRX-3");
  });
});
