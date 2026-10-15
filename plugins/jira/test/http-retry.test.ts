import { describe, expect, it } from "vitest";
import {
  createFixtureJiraProvider,
  createMockFetch,
  createMockJiraState,
} from "../src/rest-provider.js";
import { isTransientError } from "../src/http.js";
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

describe("jira transport retry", () => {
  it("retries a transient GET then succeeds", async () => {
    process.env.PRAXIS_JIRA_RETRY_BACKOFF_MS = "0";
    const state = createMockJiraState();
    const inner = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    const provider = createFixtureJiraProvider({ config: cfg(), fetchImpl: inner });
    const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
    let failed = false;
    const flaky: typeof fetch = async (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && !failed) {
        failed = true;
        const err = new Error("other side closed");
        (err as { code?: string }).code = "UND_ERR_SOCKET";
        throw err;
      }
      return inner(input, init);
    };
    const retrying = createFixtureJiraProvider({ config: cfg(), fetchImpl: flaky });
    const got = await retrying.getIssue(epic.key);
    expect(got.key).toBe(epic.key);
    expect(failed).toBe(true);
  });

  it("fails after bounded GET retries with contextual error", async () => {
    process.env.PRAXIS_JIRA_RETRY_BACKOFF_MS = "0";
    const flaky: typeof fetch = async () => {
      const err = new Error("other side closed");
      (err as { code?: string }).code = "UND_ERR_SOCKET";
      throw err;
    };
    const provider = createFixtureJiraProvider({ config: cfg(), fetchImpl: flaky });
    await expect(provider.getIssue("PRX-1")).rejects.toThrow(
      /Jira cloud GET .* failed after 3 attempt/,
    );
  });

  it("does not blindly retry POST createIssue", async () => {
    process.env.PRAXIS_JIRA_RETRY_BACKOFF_MS = "0";
    const state = createMockJiraState();
    const inner = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    let posts = 0;
    const flaky: typeof fetch = async (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const url = String(input);
      if (method === "POST" && /\/issue$/.test(new URL(url).pathname)) {
        posts += 1;
        const err = new Error("other side closed");
        (err as { code?: string }).code = "UND_ERR_SOCKET";
        throw err;
      }
      return inner(input, init);
    };
    const provider = createFixtureJiraProvider({ config: cfg(), fetchImpl: flaky });
    await expect(
      provider.createIssue({ summary: "x", issueType: "Task" }),
    ).rejects.toThrow(/failed after 1 attempt/);
    expect(posts).toBe(1);
  });

  it("classifies UND_ERR_SOCKET as transient", () => {
    const err = new Error("other side closed");
    (err as { code?: string }).code = "UND_ERR_SOCKET";
    expect(isTransientError(err)).toBe(true);
  });
});
