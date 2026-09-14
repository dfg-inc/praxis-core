import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadJiraConfig,
  detectJiraMode,
} from "../src/config.js";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
} from "../src/rest-provider.js";
import { renderRichTextAdf, renderRichTextWiki } from "../src/rich-text.js";
import { assertRole, roleAllows } from "../src/role-policy.js";
import {
  architectPlanEpic,
  assertQaPathAllowed,
  baAnalyzeEpic,
  claimWorkPackage,
  collectEpicStatus,
  developerCompleteWp,
  parseCoverage,
  qaVerifyWorkPackage,
} from "../src/workflows.js";
import { loadWriteJournal } from "../src/write-journal.js";
import { resolveBaArtifactId } from "../src/artifact-id.js";
import type { PraxisRichTextDocument } from "@praxis/contracts";
import type { JiraConfig } from "../src/config.js";

const SAMPLE_DOC: PraxisRichTextDocument = {
  version: 1,
  blocks: [
    { type: "heading", level: 2, text: "Hello" },
    {
      type: "paragraph",
      inlines: [
        { type: "text", text: "See " },
        { type: "code", text: "foo" },
        { type: "text", text: " and " },
        { type: "link", href: "https://example.com", text: "link" },
        { type: "text", text: " " },
        { type: "issueRef", key: "PRX-1" },
      ],
    },
    { type: "bulletList", items: [[{ type: "text", text: "one" }]] },
    { type: "orderedList", items: [[{ type: "text", text: "two" }]] },
    { type: "codeBlock", language: "mermaid", text: "flowchart LR\nA-->B" },
    {
      type: "table",
      headers: ["A", "B"],
      rows: [["1", "2"]],
    },
  ],
};

function cfg(mode: "cloud" | "datacenter"): JiraConfig {
  return {
    mode,
    baseUrl:
      mode === "cloud"
        ? "https://acme.atlassian.net"
        : "https://jira.example.com",
    token: "tok",
    projectKey: "PRX",
    email: mode === "cloud" ? "dev@example.com" : undefined,
    authMode: mode === "cloud" ? "cloud-basic" : "pat",
    epicType: "Epic",
    storyType: "Story",
    taskType: "Task",
    bugType: "Bug",
    workPackageType: "",
    transitions: {},
    workPackageMaxHours: 16,
  };
}

async function seedEpic(mode: "cloud" | "datacenter") {
  const state = createMockJiraState();
  const fetchImpl = createMockFetch(state, {
    flavor: mode,
    projectKey: "PRX",
  });
  const provider = createJiraProvider({ config: cfg(mode), fetchImpl });
  const epic = await provider.createIssue({
    summary: "Demo epic",
    issueType: "Epic",
    description: provider.renderDescription(SAMPLE_DOC),
  });
  return { provider, state, epicKey: epic.key, fetchImpl };
}

describe("jira mode/config", () => {
  it("detects cloud from atlassian.net", () => {
    expect(
      detectJiraMode({}, "https://x.atlassian.net"),
    ).toBe("cloud");
  });
  it("auto fails without URL host", () => {
    expect(() =>
      detectJiraMode({ PRAXIS_JIRA_MODE: "auto" }, ""),
    ).toThrow(/explicitly/);
  });
  it("cloud requires email", () => {
    expect(() =>
      loadJiraConfig({
        PRAXIS_JIRA_MODE: "cloud",
        PRAXIS_JIRA_BASE_URL: "https://x.atlassian.net",
        PRAXIS_JIRA_TOKEN: "t",
        PRAXIS_JIRA_PROJECT_KEY: "PRX",
      }),
    ).toThrow(/EMAIL/);
  });
});

describe("rich text", () => {
  it("renders the same document for Cloud ADF and DC wiki", () => {
    const adf = renderRichTextAdf(SAMPLE_DOC) as { type: string; content: unknown[] };
    const wiki = renderRichTextWiki(SAMPLE_DOC);
    expect(adf.type).toBe("doc");
    expect(adf.content.length).toBe(SAMPLE_DOC.blocks.length);
    expect(wiki).toMatch(/h2\. Hello/);
    expect(wiki).toMatch(/\{code:mermaid\}/);
    expect(wiki).toMatch(/\|\|A\|\|B\|\|/);
  });
});

describe.each([["cloud"], ["datacenter"]] as const)(
  "JiraProvider contract (%s)",
  (mode) => {
    it("auth headers and CRUD request shapes", async () => {
      const { provider, epicKey } = await seedEpic(mode);
      const headers = (provider as { lastAuthHeader?: () => string }).lastAuthHeader?.();
      if (mode === "cloud") {
        expect(headers).toMatch(/^Basic /);
        expect(headers).not.toMatch(/^Bearer /);
      } else {
        expect(headers).toBe("Bearer tok");
      }
      const me = await provider.getCurrentUser();
      expect(me.accountId).toBeTruthy();
      const info = await provider.getServerInfo();
      expect(info.version).toBeTruthy();
      const issue = await provider.getIssue(epicKey);
      expect(issue.summary).toBe("Demo epic");
      await provider.addComment(epicKey, provider.renderDescription(SAMPLE_DOC));
      const comments = await provider.getComments(epicKey);
      expect(comments.length).toBe(1);
      const story = await provider.createIssue({
        summary: "Child",
        issueType: "Story",
        parentKey: epicKey,
      });
      await provider.createIssueLink(epicKey, story.key);
      const children = await provider.getChildren(epicKey);
      expect(children.some((c) => c.key === story.key)).toBe(true);
      await provider.transitionIssue(story.key, "In Progress");
      const after = await provider.getIssue(story.key);
      expect(after.status).toBe("In Progress");
      await provider.assignIssue(story.key, me.accountId);
    });
  },
);

describe("role policy", () => {
  it("denies BA developer claim", () => {
    expect(roleAllows("ba", "claim-work-package")).toBe(false);
    expect(() => assertRole("ba", "claim-work-package")).toThrow(/deny/);
  });
  it("denies Architect QA pass", () => {
    expect(() => assertRole("architect", "qa-pass")).toThrow(/deny/);
  });
  it("denies Developer requirement rewrite", () => {
    expect(() => assertRole("developer", "rewrite-requirements")).toThrow(/deny/);
  });
  it("denies QA architecture rewrite", () => {
    expect(() => assertRole("qa", "rewrite-architecture")).toThrow(/deny/);
  });
});

describe("jira workflow orchestration", () => {
  it("BA epic→stories is idempotent", async () => {
    const { provider, epicKey } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const first = await baAnalyzeEpic({ provider, epicKey, repo });
    expect(first.storyKeys.length).toBe(1);
    const second = await baAnalyzeEpic({ provider, epicKey, repo });
    expect(second.created).toEqual([]);
    expect(second.storyKeys).toEqual(first.storyKeys);
  });

  it("Architect groups stories into work packages without orphans", async () => {
    const { provider, epicKey } = await seedEpic("datacenter");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    await baAnalyzeEpic({ provider, epicKey, repo });
    const plan = await architectPlanEpic({ provider, epicKey, repo });
    expect(plan.workPackages.length).toBeGreaterThan(0);
    for (const wp of plan.workPackages) {
      expect(wp.storyKeys.length).toBeGreaterThan(0);
      expect(wp.taskKeys.length).toBeGreaterThan(0);
    }
    const again = await architectPlanEpic({ provider, epicKey, repo });
    expect(again.workPackages.map((w) => w.jiraIssueKey)).toEqual(
      plan.workPackages.map((w) => w.jiraIssueKey),
    );
  });

  it("claim: first wins, second denied, same actor resumes", async () => {
    const { provider, epicKey } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    await baAnalyzeEpic({ provider, epicKey, repo });
    const { workPackages } = await architectPlanEpic({ provider, epicKey, repo });
    const wpKey = workPackages[0]!.jiraIssueKey;
    const first = await claimWorkPackage({
      provider,
      wpKey,
      repo,
      actor: "dev-a",
      accountId: "acct-a",
    });
    expect(first.state).toBe("active");
    await expect(
      claimWorkPackage({
        provider,
        wpKey,
        repo,
        actor: "dev-b",
        accountId: "acct-b",
      }),
    ).rejects.toThrow(/claim denied/);
    const resume = await claimWorkPackage({
      provider,
      wpKey,
      repo,
      actor: "dev-a",
      accountId: "acct-a",
    });
    expect(resume.claimToken).toBe(first.claimToken);
  });

  it("detects a claim token race as blocked", async () => {
    const { provider, epicKey, state } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    await baAnalyzeEpic({ provider, epicKey, repo });
    const { workPackages } = await architectPlanEpic({ provider, epicKey, repo });
    const wpKey = workPackages[0]!.jiraIssueKey;
    const issue = state.issues.get(wpKey)!;
    const origPut = issue.properties;
    void origPut;
    const wrappedFetch = createMockFetch(state, {
      flavor: "cloud",
      projectKey: "PRX",
    });
    const racing: typeof fetch = async (input, init) => {
      const url = String(input);
      const res = await wrappedFetch(input, init);
      if (
        (init?.method ?? "GET").toUpperCase() === "PUT" &&
        url.includes("/properties/praxis.claim")
      ) {
        issue.properties["praxis.claim"] = {
          claimToken: "stolen",
          actor: "other",
          jiraAccountId: "other",
          state: "active",
        };
      }
      return res;
    };
    const racingProvider = createJiraProvider({
      config: cfg("cloud"),
      fetchImpl: racing,
    });
    await expect(
      claimWorkPackage({
        provider: racingProvider,
        wpKey,
        repo,
        actor: "dev-a",
        accountId: "acct-a",
      }),
    ).rejects.toThrow(/race/);
  });

  it("Developer ready-for-QA only after verification covering all issues", async () => {
    const { provider, epicKey } = await seedEpic("datacenter");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    await baAnalyzeEpic({ provider, epicKey, repo });
    const { workPackages } = await architectPlanEpic({ provider, epicKey, repo });
    const wpKey = workPackages[0]!.jiraIssueKey;
    await claimWorkPackage({
      provider,
      wpKey,
      repo,
      actor: "dev-a",
      accountId: "acct-a",
    });
    await expect(
      developerCompleteWp({
        provider,
        wpKey,
        repo,
        evidence: { verification: { ok: false } },
      }),
    ).rejects.toThrow(/verification/);
    await developerCompleteWp({
      provider,
      wpKey,
      repo,
      evidence: { verification: { ok: true }, tests: "npm test", branch: "feat/wp" },
    });
    const state = await provider.readPraxisState<{ lifecycle: string }>(wpKey);
    expect(state?.lifecycle).toBe("ready-for-qa");
  });

  it("QA coverage/source-guard/bug dedupe/block", async () => {
    const { provider, epicKey } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    writeFileSync(
      join(repo, ".project"),
      "stack: [node]\nquality:\n  build: \"node -e process.exit(0)\"\n  test: \"node -e process.exit(0)\"\n",
    );
    await baAnalyzeEpic({ provider, epicKey, repo });
    const { workPackages } = await architectPlanEpic({ provider, epicKey, repo });
    const wpKey = workPackages[0]!.jiraIssueKey;
    expect(() => assertQaPathAllowed("src/index.ts")).toThrow(/source guard/);
    assertQaPathAllowed("tests/foo.test.ts");
    expect(parseCoverage("Lines        : 80.1%")).toMatchObject({ lines: 80.1 });
    const report = await qaVerifyWorkPackage({
      provider,
      wpKey,
      repo,
      findings: [
        { fingerprint: "gap-1", blocking: true, summary: "AC unverified" },
      ],
    });
    expect(report.overallVerdict).toBe("blocked");
    const again = await qaVerifyWorkPackage({
      provider,
      wpKey,
      repo,
      findings: [
        { fingerprint: "gap-1", blocking: true, summary: "AC unverified" },
      ],
    });
    expect(again.overallVerdict).toBe("blocked");
    const bugs = await provider.searchIssues("issuetype = Bug AND project = PRX");
    expect(bugs.length).toBe(1);
  });
});

const CORE_SPEC = (epicKey: string, summary = "Counter library: add reset()") => ({
  logicalId: `REQ-${epicKey}-1`,
  summary,
  userStory: "As a developer I want reset() So that the counter returns to zero",
  acceptanceCriteria: "Given a counter When reset Then value is 0",
  requirementIds: [`REQ-${epicKey}-1`],
});

describe("BA remote-write idempotency", () => {
  it("A first apply creates exactly once and commits journal", async () => {
    const { provider, epicKey, state } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const before = state.createIssueCount;
    const first = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey)],
    });
    expect(state.createIssueCount - before).toBe(1);
    expect(first.created).toHaveLength(1);
    expect(first.storyKeys).toHaveLength(1);
    const ops = loadWriteJournal(repo).filter((e) => e.artifactId.includes("REQ-"));
    expect(ops.some((e) => e.state === "committed")).toBe(true);
  });

  it("B second identical apply does not create (UNCHANGED)", async () => {
    const { provider, epicKey, state } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const first = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey)],
    });
    const afterFirst = state.createIssueCount;
    const second = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey)],
    });
    expect(state.createIssueCount).toBe(afterFirst);
    expect(second.created).toEqual([]);
    expect(second.storyKeys).toEqual(first.storyKeys);
    expect(second.plan.some((p) => p.action === "UNCHANGED")).toBe(true);
  });

  it("C changed description updates existing, no create", async () => {
    const { provider, epicKey, state } = await seedEpic("datacenter");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const first = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey)],
    });
    const after = state.createIssueCount;
    const second = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [
        {
          ...CORE_SPEC(epicKey),
          acceptanceCriteria: "Given x When y Then z (updated)",
        },
      ],
    });
    expect(state.createIssueCount).toBe(after);
    expect(second.storyKeys).toEqual(first.storyKeys);
    expect(second.plan.some((p) => p.action === "UPDATE")).toBe(true);
  });

  it("D new process recovers remote canonical", async () => {
    const { provider, epicKey, state } = await seedEpic("cloud");
    const repo1 = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const first = await baAnalyzeEpic({
      provider,
      epicKey,
      repo: repo1,
      stories: [CORE_SPEC(epicKey)],
    });
    const after = state.createIssueCount;
    const repo2 = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const second = await baAnalyzeEpic({
      provider,
      epicKey,
      repo: repo2,
      stories: [CORE_SPEC(epicKey)],
    });
    expect(state.createIssueCount).toBe(after);
    expect(second.storyKeys).toEqual(first.storyKeys);
  });

  it("E crash after HTTP create: resume does not duplicate", async () => {
    const { provider, epicKey, state } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    await expect(
      baAnalyzeEpic({
        provider,
        epicKey,
        repo,
        stories: [CORE_SPEC(epicKey)],
        hooks: { crashAfterCreate: true },
      }),
    ).rejects.toThrow(/injected crash: after create/);
    const afterCrash = state.createIssueCount;
    const resume = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey)],
    });
    expect(state.createIssueCount).toBe(afterCrash);
    expect(resume.storyKeys).toHaveLength(1);
    expect(resume.created).toEqual([]);
  });

  it("F crash after metadata property: no duplicate", async () => {
    const { provider, epicKey, state } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    await expect(
      baAnalyzeEpic({
        provider,
        epicKey,
        repo,
        stories: [CORE_SPEC(epicKey)],
        hooks: { crashAfterProperty: true },
      }),
    ).rejects.toThrow(/injected crash: after property/);
    const afterCrash = state.createIssueCount;
    const resume = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey)],
    });
    expect(state.createIssueCount).toBe(afterCrash);
    expect(resume.storyKeys).toHaveLength(1);
  });

  it("G duplicate remote fixtures: one canonical, one superseded, no third", async () => {
    const { provider, epicKey, state } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const artifactId = resolveBaArtifactId({
      epicKey,
      requirementIds: [`REQ-${epicKey}-1`],
    });
    const a = await provider.createIssue({
      summary: "Counter library: add reset()",
      issueType: "Story",
      parentKey: epicKey,
      labels: ["praxis-managed"],
    });
    const b = await provider.createIssue({
      summary: "Counter library: add reset()",
      issueType: "Story",
      parentKey: epicKey,
      labels: ["praxis-managed"],
    });
    await provider.setIssueProperty(a.key, "praxis.artifactId", artifactId);
    await provider.setIssueProperty(b.key, "praxis.artifactId", artifactId);
    const before = state.createIssueCount;
    const result = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey)],
    });
    expect(state.createIssueCount).toBe(before);
    expect(result.storyKeys).toEqual([a.key]);
    expect(result.handoff.canonicalStoryKeys).toEqual([a.key]);
    expect(result.handoff.supersededStoryKeys).toContain(b.key);
    const dup = await provider.getIssue(b.key);
    expect(dup.labels).toContain("praxis-duplicate");
  });

  it("H summary change keeps logical identity and same Jira key", async () => {
    const { provider, epicKey, state } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const first = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey, "old summary")],
    });
    const after = state.createIssueCount;
    const second = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey, "new summary")],
    });
    expect(state.createIssueCount).toBe(after);
    expect(second.storyKeys).toEqual(first.storyKeys);
    const issue = await provider.getIssue(first.storyKeys[0]!);
    expect(issue.summary).toBe("new summary");
  });

  it("live-like PRX-2 superseded summary / PRX-3 canonical without creating a fourth", async () => {
    const { provider, epicKey, state } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const dup = await provider.createIssue({
      summary:
        "[DUPLICATE — superseded by PRX-3] Counter library: add reset() to return the counter to zero",
      issueType: "Story",
      parentKey: epicKey,
    });
    const canonical = await provider.createIssue({
      summary: "Counter library: add reset() to return the counter to zero",
      issueType: "Story",
      parentKey: epicKey,
    });
    expect(dup.key).toBe("PRX-2");
    expect(canonical.key).toBe("PRX-3");
    const before = state.createIssueCount;
    const result = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey)],
    });
    expect(state.createIssueCount).toBe(before);
    expect(result.storyKeys).toEqual(["PRX-3"]);
    expect(result.created).toEqual([]);
  });
});

describe("canonical/superseded downstream", () => {
  async function seededWithDuplicate() {
    const seeded = await seedEpic("cloud");
    const { provider, epicKey } = seeded;
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const artifactId = resolveBaArtifactId({
      epicKey,
      requirementIds: [`REQ-${epicKey}-1`],
    });
    const superseded = await provider.createIssue({
      summary: "dup",
      issueType: "Story",
      parentKey: epicKey,
      labels: ["praxis-duplicate"],
    });
    await provider.setIssueProperty(superseded.key, "praxis.superseded", true);
    await provider.setIssueProperty(superseded.key, "praxis.supersededBy", "PRX-3");
    await provider.setIssueProperty(superseded.key, "praxis.artifactId", artifactId);
    const canonical = await provider.createIssue({
      summary: "canon",
      issueType: "Story",
      parentKey: epicKey,
    });
    await provider.setIssueProperty(canonical.key, "praxis.artifactId", artifactId);
    const ba = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
      stories: [CORE_SPEC(epicKey)],
    });
    return { ...seeded, repo, ba, superseded, canonical };
  }

  it("Architect and Work Package consume only canonical", async () => {
    const { provider, epicKey, repo, ba, superseded } = await seededWithDuplicate();
    expect(ba.handoff.storyKeys).not.toContain(superseded.key);
    const plan = await architectPlanEpic({ provider, epicKey, repo });
    expect(plan.workPackages).toHaveLength(1);
    expect(plan.workPackages[0]!.storyKeys).toEqual(ba.storyKeys);
    expect(plan.workPackages[0]!.storyKeys).not.toContain(superseded.key);
  });

  it("Developer claim rejects superseded-only members and QA skips them", async () => {
    const { provider, epicKey, repo, ba, superseded } = await seededWithDuplicate();
    const { workPackages } = await architectPlanEpic({ provider, epicKey, repo });
    const wpKey = workPackages[0]!.jiraIssueKey;
    const claim = await claimWorkPackage({
      provider,
      wpKey,
      repo,
      actor: "dev-a",
      accountId: "acct-a",
    });
    expect(claim.memberIssueKeys).not.toContain(superseded.key);
    writeFileSync(
      join(repo, ".project"),
      "stack: [node]\nquality:\n  build: \"node -e process.exit(0)\"\n  test: \"node -e process.exit(0)\"\n",
    );
    await developerCompleteWp({
      provider,
      wpKey,
      repo,
      evidence: { verification: { ok: true } },
    });
    const report = await qaVerifyWorkPackage({ provider, wpKey, repo });
    expect(report.memberIssueResults.map((r) => r.jiraIssueKey)).not.toContain(
      superseded.key,
    );
    const status = await collectEpicStatus(provider, epicKey);
    expect(status.canonicalStories).toEqual(ba.storyKeys);
    expect(status.superseded.some((s) => s.from === superseded.key)).toBe(true);
  });
});

