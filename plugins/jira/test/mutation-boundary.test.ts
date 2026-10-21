import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureJiraProvider, createJiraProvider, createMockFetch, createMockJiraState } from "../src/rest-provider.js";
import { claimWorkPackage } from "../src/workflows.js";
import { markSuperseded } from "../src/managed-scope.js";
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

describe("direct Jira mutations", () => {
  it("does not write when claim is called without the user's approval", async () => {
    const state = createMockJiraState();
    const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    const provider = createFixtureJiraProvider({ config: cfg(), fetchImpl });
    const issue = await provider.createIssue({ summary: "WP", issueType: "Task" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-boundary-"));
    const before = JSON.stringify(state.issues.get(issue.key));
    await expect(claimWorkPackage({
      provider,
      wpKey: issue.key,
      repo,
      actor: "dev",
      accountId: "acct",
    })).rejects.toThrow(/approval/i);
    expect(JSON.stringify(state.issues.get(issue.key))).toBe(before);
  });

  it("does not mark an issue superseded without an authorized lease", async () => {
    const state = createMockJiraState();
    const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    const provider = createFixtureJiraProvider({ config: cfg(), fetchImpl });
    const issue = await provider.createIssue({ summary: "dup", issueType: "Story" });
    const before = JSON.stringify(state.issues.get(issue.key));
    await expect(markSuperseded(provider, issue.key, "PRX-1")).rejects.toThrow(/not authorized/);
    expect(JSON.stringify(state.issues.get(issue.key))).toBe(before);
  });

  it("does not let a direct provider write bypass the lease", async () => {
    const state = createMockJiraState();
    const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    const provider = createJiraProvider({ config: cfg(), fetchImpl });
    await expect(provider.createIssue({ summary: "bypass", issueType: "Task" })).rejects.toThrow(/not authorized/);
    expect(state.issues.size).toBe(0);
  });
});
