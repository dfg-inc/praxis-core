import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadJiraConfig,
  detectJiraMode,
} from "../src/config.js";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
  LOCALIZED_RU_ISSUE_TYPES,
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
  previewQualityApply,
  applyQualityReview,
  writeQualityEvidence,
} from "../src/workflows.js";
import { loadWriteJournal } from "../src/write-journal.js";
import { resolveBaArtifactId } from "../src/artifact-id.js";
import { writeJsonAtomic, readJsonFile } from "../src/atomic-json.js";
import { JiraBaHandoffSchema } from "@praxis/contracts";
import { launchRole, findClaudeBin } from "../../../tools/scripts/claude-launch.mjs";
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

function seedCanonicalWp(repo: string, id = "WP-20260914-002") {
  const dir = join(repo, "design", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.md"),
    "# Counter Reset\n\nImplement reset() on the counter library.\n",
  );
  writeFileSync(
    join(dir, "change-spec.json"),
    `${JSON.stringify({ id, files: ["src/index.js"] }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "architect-developer.handoff.json"),
    `${JSON.stringify({
      contract: "architect.developer.handoff",
      version: "1.0.0",
      workPackageId: id,
    }, null, 2)}\n`,
  );
}

function storySpec(epicKey: string, summary = "core story") {
  return {
    logicalId: `REQ-${epicKey}-1`,
    summary,
    userStory: "As a user I want a capability So that value is delivered",
    acceptanceCriteria: "Given context\nWhen action\nThen outcome",
    requirementIds: [`REQ-${epicKey}-1`],
  };
}

function analyze(
  provider: Awaited<ReturnType<typeof seedEpic>>["provider"],
  epicKey: string,
  repo: string,
  extra: Partial<Parameters<typeof baAnalyzeEpic>[0]> = {},
) {
  const { stories, ...rest } = extra;
  return baAnalyzeEpic({
    provider,
    epicKey,
    repo,
    stories: stories ?? [storySpec(epicKey)],
    ...rest,
  });
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
      await provider.transitionIssue(story.key, "21");
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
    const first = await analyze(provider, epicKey, repo);
    expect(first.storyKeys.length).toBe(1);
    const second = await analyze(provider, epicKey, repo);
    expect(second.created).toEqual([]);
    expect(second.storyKeys).toEqual(first.storyKeys);
  });

  it("Architect groups stories into work packages without orphans", async () => {
    const { provider, epicKey } = await seedEpic("datacenter");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    await analyze(provider, epicKey, repo);
    seedCanonicalWp(repo);
    const plan = await architectPlanEpic({ provider, epicKey, repo });
    expect(plan.workPackages.length).toBeGreaterThan(0);
    for (const wp of plan.workPackages) {
      expect(wp.storyKeys.length).toBeGreaterThan(0);
      expect(wp.taskKeys.length).toBe(0);
      expect(wp.id).toMatch(/^WP-\d{8}-\d+$/);
    }
    const again = await architectPlanEpic({ provider, epicKey, repo });
    expect(again.workPackages.map((w) => w.jiraIssueKey)).toEqual(
      plan.workPackages.map((w) => w.jiraIssueKey),
    );
  });

  it("claim: first wins, second denied, same actor resumes", async () => {
    const { provider, epicKey } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    await analyze(provider, epicKey, repo);
    seedCanonicalWp(repo);
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
    await analyze(provider, epicKey, repo);
    seedCanonicalWp(repo);
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
    await analyze(provider, epicKey, repo);
    seedCanonicalWp(repo);
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
    writeFileSync(join(repo, "_praxis_verify.mjs"), "console.log('Tests 5 passed'); process.exit(0);\n");
    writeFileSync(
      join(repo, ".project"),
      "stack: [node]\nquality:\n  test: node _praxis_verify.mjs\n",
    );
    const result = await developerCompleteWp({
      provider,
      wpKey,
      repo,
      evidence: { verification: { ok: true }, tests: "npm test", branch: "feat/wp" },
    });
    const state = await provider.readPraxisState<{ lifecycle: string; readyForQuality?: boolean }>(wpKey);
    expect(state?.lifecycle).toBe("ready-for-qa");
    expect(result.readyForQuality).toBe(true);
    expect(result.qualityStarted).toBe(false);
    expect(result.claimState).toBe("active");
    const issue = await provider.getIssue(wpKey);
    expect(issue.statusCategory).not.toBe("done");
    expect(existsSync(result.evidencePath)).toBe(true);
    expect(existsSync(result.qualityHandoffPath)).toBe(true);
  });

  it("QA coverage/source-guard/bug dedupe/block", async () => {
    const { provider, epicKey } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    writeFileSync(
      join(repo, ".project"),
      "stack: [node]\nquality:\n  build: \"node -e process.exit(0)\"\n  test: \"node -e process.exit(0)\"\n",
    );
    await analyze(provider, epicKey, repo);
    seedCanonicalWp(repo);
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
    expect((await provider.searchIssues("issuetype = Bug AND project = PRX")).length).toBe(0);
    writeQualityEvidence(repo, {
      reviewId: 1,
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: wpKey,
      verdict: "FAILED",
      findings: [
        {
          fingerprint: "gap-1",
          blocking: true,
          summary: "AC unverified",
          acceptanceCheckId: "AC1",
        },
      ],
      snapshot: { digest: "", files: [] },
      acceptanceChecks: [{ id: "AC1", status: "FAILED" }],
    });
    const preview = await previewQualityApply({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
    });
    expect(preview.plan.bugsProposed).toBe(1);
    expect(preview.jiraMutated).toBe(false);
    const applied = await applyQualityReview({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
      previewFingerprint: preview.previewFingerprint,
    });
    expect(applied.ok).toBe(true);
    expect(applied.bugsCreated).toHaveLength(1);
    const preview2 = await previewQualityApply({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
    });
    const again = await applyQualityReview({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
      previewFingerprint: preview2.previewFingerprint,
    });
    expect(again.bugsCreated.length + applied.bugsCreated.length).toBeGreaterThanOrEqual(1);
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
    const baText =
      "User Story\nAs a developer I want reset()\nBusiness context\nCounter\nAcceptance Criteria\nGiven a counter When reset Then 0\nRequirement IDs\nREQ-PRX-1-1";
    const dup = await provider.createIssue({
      summary:
        "[DUPLICATE — superseded by PRX-3] Counter library: add reset() to return the counter to zero",
      issueType: "Story",
      parentKey: epicKey,
      description: baText,
    });
    const canonical = await provider.createIssue({
      summary: "Counter library: add reset() to return the counter to zero",
      issueType: "Story",
      parentKey: epicKey,
      description: baText,
    });
    await provider.addComment(
      epicKey,
      provider.renderDescription({
        version: 1,
        blocks: [
          {
            type: "paragraph",
            inlines: [
              {
                type: "text",
                text: "Praxis BA handoff ready. Stories: PRX-3",
              },
            ],
          },
        ],
      }),
    );
    expect(dup.key).toBe("PRX-2");
    expect(canonical.key).toBe("PRX-3");
    const before = state.createIssueCount;
    const result = await baAnalyzeEpic({
      provider,
      epicKey,
      repo,
    });
    expect(result.reason).not.toBe("BA_PROPOSAL_MISSING");
    expect(state.createIssueCount).toBe(before);
    expect(result.storyKeys).toEqual(["PRX-3"]);
    expect(result.created).toEqual([]);
    expect(result.plan.some((p) => p.action === "CREATE")).toBe(false);
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
    seedCanonicalWp(repo);
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
    writeFileSync(join(repo, "_praxis_verify.mjs"), "process.exit(0);\n");
    writeFileSync(
      join(repo, ".project"),
      "stack: [node]\nquality:\n  build: node _praxis_verify.mjs\n  test: node _praxis_verify.mjs\n",
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

describe("child hydration", () => {
  it("Cloud sparse search still returns keys, summaries, parent, properties", async () => {
    const { provider, epicKey, fetchImpl } = await seedEpic("cloud");
    const child = await provider.createIssue({
      summary: "Real summary",
      issueType: "Story",
      parentKey: epicKey,
      labels: ["praxis-managed"],
    });
    await provider.setIssueProperty(child.key, "praxis.artifactId", "ba:PRX-1:x");
    const sparse: typeof fetch = async (input, init) => {
      const res = await fetchImpl(input, init);
      const url = String(input);
      if (url.includes("/search")) {
        const body = (await res.json()) as {
          issues: { id: string; key: string; fields: unknown }[];
        };
        return new Response(
          JSON.stringify({
            issues: body.issues.map((i) => ({ id: i.id })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return res;
    };
    const hydrating = createJiraProvider({
      config: cfg("cloud"),
      fetchImpl: sparse,
    });
    const children = await hydrating.getChildren(epicKey);
    expect(children.some((c) => c.key === child.key)).toBe(true);
    const hit = children.find((c) => c.key === child.key)!;
    expect(hit.summary).toBe("Real summary");
    expect(hit.parentKey).toBe(epicKey);
    expect(hit.properties["praxis.artifactId"]).toBe("ba:PRX-1:x");
  });

  it("Data Center search with fields still hydrates keys and properties", async () => {
    const { provider, epicKey } = await seedEpic("datacenter");
    const child = await provider.createIssue({
      summary: "DC child",
      issueType: "Story",
      parentKey: epicKey,
      labels: ["praxis-managed"],
    });
    await provider.setIssueProperty(child.key, "praxis.managed", true);
    const children = await provider.getChildren(epicKey);
    const hit = children.find((c) => c.key === child.key)!;
    expect(hit.key).toBe(child.key);
    expect(hit.summary).toBe("DC child");
    expect(hit.parentKey).toBe(epicKey);
    expect(hit.properties["praxis.managed"]).toBe(true);
  });
});

describe("BA proposal vs machine", () => {
  it("without proposal does not synthesize generic AC", async () => {
    const { provider, epicKey } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const result = await baAnalyzeEpic({ provider, epicKey, repo, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("BA_PROPOSAL_MISSING");
    expect(result.planText).not.toMatch(/Given the epic is in Jira/);
    expect(result.planText).not.toMatch(/core story/);
    expect(result.handoff.readyForArchitecture).toBe(false);
    expect(result.handoff.canonicalStoryKeys).toEqual([]);
  });

  it("schema rejects readyForArchitecture with empty canonical keys", () => {
    const parsed = JiraBaHandoffSchema.safeParse({
      contract: "jira.ba.architect.handoff",
      version: "1.0.0",
      epicKey: "PRX-1",
      storyKeys: [],
      canonicalStoryKeys: [],
      supersededStoryKeys: [],
      requirementIds: [],
      baArtifacts: [],
      openQuestions: [],
      nfrs: [],
      businessRules: [],
      constraints: [],
      acceptanceSummary: "",
      dependencies: [],
      proposalReady: false,
      readyForArchitecture: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("Architect skips invalid/truncated handoff without raw SyntaxError", async () => {
    const { provider, epicKey } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    mkdirSync(join(repo, ".praxis-jira", "handoffs"), { recursive: true });
    writeFileSync(join(repo, ".praxis-jira", "handoffs", `${epicKey}.json`), "{");
    await expect(
      architectPlanEpic({ provider, epicKey, repo, dryRun: true }),
    ).rejects.toThrow(/BA_REMOTE_APPLY_INCOMPLETE/);
  });
});

describe("atomic artifacts", () => {
  it("keeps previous JSON if temp write is not renamed", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-json-"));
    const file = join(dir, "handoff.json");
    writeJsonAtomic(file, { ok: 1 });
    const first = readJsonFile<{ ok: number }>(file, "handoff");
    expect(first.ok && first.value.ok).toBe(1);
    const empty = readJsonFile(join(dir, "missing.json"), "handoff");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe("missing");
  });
});

describe("migration conflict", () => {
  it("two active praxis-shaped stories without superseded stop with MIGRATION_CONFLICT", async () => {
    const { provider, epicKey, state } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const body =
      "User Story\nAs a x\nAcceptance Criteria\nGiven When Then\nRequirement IDs\nREQ-A";
    await provider.createIssue({
      summary: "one",
      issueType: "Story",
      parentKey: epicKey,
      description: body,
    });
    await provider.createIssue({
      summary: "two",
      issueType: "Story",
      parentKey: epicKey,
      description: body,
    });
    const before = state.createIssueCount;
    const result = await baAnalyzeEpic({ provider, epicKey, repo, dryRun: true });
    expect(result.reason).toBe("MIGRATION_CONFLICT");
    expect(state.createIssueCount).toBe(before);
  });

  it("does not adopt an unrelated human child", async () => {
    const { provider, epicKey } = await seedEpic("cloud");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    await provider.createIssue({
      summary: "Random human note",
      issueType: "Task",
      parentKey: epicKey,
      description: "please fix later",
    });
    const result = await baAnalyzeEpic({ provider, epicKey, repo, dryRun: true });
    expect(result.reason).toBe("BA_PROPOSAL_MISSING");
  });
});

describe("claude launcher", () => {
  it("launches fake binary with plugin-dir and cwd=repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-role-"));
    mkdirSync(join(repo, "node_modules/@praxis/ba/.claude-plugin"), {
      recursive: true,
    });
    writeFileSync(
      join(repo, "node_modules/@praxis/ba/.claude-plugin/plugin.json"),
      '{"name":"praxis-ba"}\n',
    );
    const fake = join(repo, "fake-claude.mjs");
    const capture = join(repo, "capture.json");
    writeFileSync(
      fake,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.env.PRAXIS_CLAUDE_CAPTURE, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));
`,
    );
    const env = {
      ...process.env,
      PRAXIS_CLAUDE_BIN: process.execPath,
      PRAXIS_CLAUDE_CAPTURE: capture,
      PRAXIS_JIRA_MODE: "cloud",
      PRAXIS_JIRA_BASE_URL: "https://example.atlassian.net",
      PRAXIS_JIRA_PROJECT_KEY: "PRX",
      PRAXIS_JIRA_EMAIL: "dev@example.com",
      PRAXIS_JIRA_TOKEN: "secret-token-value",
    };
    const launched = launchRole({
      praxisRoot: resolve(join(import.meta.dirname, "../../..")),
      role: "ba",
      repo,
      epic: "PRX-1",
      env,
      dryLaunch: true,
    });
    expect(launched.cwd).toBe(repo);
    expect(launched.args[0]).toBe("--plugin-dir");
    expect(launched.args[1]).toContain("@praxis/ba");
    expect(launched.prompt).toMatch(/PRX-1/);
    expect(JSON.stringify(launched.args)).not.toMatch(/secret-token-value/);
  });

  it("fails when plugin missing", () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-role-"));
    expect(() =>
      launchRole({
        praxisRoot: resolve("."),
        role: "ba",
        repo,
        epic: "PRX-1",
        env: {
          PRAXIS_CLAUDE_BIN: process.execPath,
          PRAXIS_JIRA_MODE: "cloud",
          PRAXIS_JIRA_BASE_URL: "https://example.atlassian.net",
          PRAXIS_JIRA_PROJECT_KEY: "PRX",
          PRAXIS_JIRA_EMAIL: "a@b.c",
          PRAXIS_JIRA_TOKEN: "t",
        },
        dryLaunch: true,
      }),
    ).toThrow(/not installed/);
  });

  it("reports missing claude binary", () => {
    expect(findClaudeBin({ PATH: "/nonexistent", PRAXIS_CLAUDE_BIN: "" })).toBeNull();
  });
});

describe("localized issue types", () => {
  async function seedRu() {
    const state = createMockJiraState({ issueTypes: LOCALIZED_RU_ISSUE_TYPES });
    const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    const provider = createJiraProvider({ config: cfg("cloud"), fetchImpl });
    const epic = await provider.createIssue({
      summary: "Counter management improvements",
      issueType: "Epic",
    });
    return { provider, state, epicKey: epic.key };
  }

  it("История is semantic story and status lists canonical PRX-3", async () => {
    const { provider, epicKey } = await seedRu();
    const dup = await provider.createIssue({
      summary:
        "[DUPLICATE — superseded by PRX-3] Counter library: add reset() to return the counter to zero",
      issueType: "Story",
      parentKey: epicKey,
    });
    const canon = await provider.createIssue({
      summary: "Counter library: add reset() to return the counter to zero",
      issueType: "Story",
      parentKey: epicKey,
      description:
        "User Story\nAs a developer\nAcceptance Criteria\nGiven When Then\nRequirement IDs\nE2-FR1",
    });
    await provider.addComment(epicKey, "Praxis BA handoff ready. Stories: " + canon.key);
    const got = await provider.getIssue(canon.key);
    expect(got.issueType).toBe("История");
    expect(got.semanticType).toBe("story");
    const epic = await provider.getIssue(epicKey);
    expect(epic.issueType).toBe("Эпик");
    expect(epic.semanticType).toBe("epic");
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const ba = await baAnalyzeEpic({ provider, epicKey, repo, dryRun: true });
    expect(ba.plan.some((p) => p.action === "CREATE")).toBe(false);
    expect(ba.handoff.canonicalStoryKeys).toContain(canon.key);
    expect(ba.handoff.readyForArchitecture).toBe(false);
    const applied = await baAnalyzeEpic({ provider, epicKey, repo });
    expect(applied.created).toEqual([]);
    expect(applied.handoff.readyForArchitecture).toBe(true);
    const status = await collectEpicStatus(provider, epicKey);
    expect(status.canonicalStories).toContain(canon.key);
    expect(status.superseded.some((s) => s.from === dup.key && s.to === canon.key)).toBe(true);
  });

  it("English Story behaves the same", async () => {
    const { provider, epicKey } = await seedEpic("cloud");
    await provider.createIssue({
      summary: "s",
      issueType: "Story",
      parentKey: epicKey,
      description: "User Story\nAcceptance Criteria\nRequirement IDs\nREQ-1",
    });
    const children = await provider.getChildren(epicKey);
    expect(children[0]?.semanticType).toBe("story");
  });

  it("configured type ID maps arbitrary display name to story", async () => {
    const state = createMockJiraState({
      issueTypes: [
        { id: "10000", name: "Эпик", hierarchyLevel: 1, subtask: false },
        { id: "999", name: "User Need", hierarchyLevel: 0, subtask: false },
      ],
    });
    const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    const provider = createJiraProvider({
      config: { ...cfg("cloud"), storyTypeId: "999" },
      fetchImpl,
    });
    const epic = await provider.createIssue({ summary: "e", issueType: "Epic" });
    const story = await provider.createIssue({
      summary: "s",
      issueType: "Story",
      issueTypeId: "999",
      parentKey: epic.key,
    });
    const got = await provider.getIssue(story.key);
    expect(got.issueType).toBe("User Need");
    expect(got.semanticType).toBe("story");
  });

  it("managed-scope source never compares English display names", () => {
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
    const src = readFileSync(join(srcDir, "managed-scope.ts"), "utf8");
    expect(src).not.toMatch(/toLowerCase\(\)\s*===\s*"story"/);
    expect(src).not.toMatch(/===\s*"Story"/);
    const workflows = readFileSync(join(srcDir, "workflows.ts"), "utf8");
    expect(workflows).not.toMatch(/toLowerCase\(\)\s*===\s*"bug"/);
    const adopt = readFileSync(join(srcDir, "legacy-adopt.ts"), "utf8");
    expect(adopt).not.toMatch(/toLowerCase\(\)\s*!==\s*"epic"/);
  });
});

describe("empty property PUT + partial BA apply resume", () => {
  it("setIssueProperty succeeds on 200 empty JSON then rereads", async () => {
    const { provider, epicKey } = await seedEpic("cloud");
    await provider.setIssueProperty(epicKey, "praxis.artifactId", "ba:PRX-1:x");
    expect(await provider.getIssueProperty(epicKey, "praxis.artifactId")).toBe(
      "ba:PRX-1:x",
    );
  });

  it("resume after crash after property write creates no extra issue and one handoff comment", async () => {
    const state = createMockJiraState({
      issueTypes: LOCALIZED_RU_ISSUE_TYPES,
      propertyPutStatus: 200,
    });
    const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    const provider = createJiraProvider({ config: cfg("cloud"), fetchImpl });
    const epic = await provider.createIssue({
      summary: "Counter management improvements",
      issueType: "Epic",
    });
    await provider.createIssue({
      summary: "[DUPLICATE — superseded by PRX-3] Counter library: add reset()",
      issueType: "Story",
      parentKey: epic.key,
    });
    const canon = await provider.createIssue({
      summary: "Counter library: add reset()",
      issueType: "Story",
      parentKey: epic.key,
      description:
        "User Story\nAs a developer I want reset\nAcceptance Criteria\nGiven When Then\nRequirement IDs\nE2-FR1",
    });
    await provider.setIssueProperty(canon.key, "praxis.artifactId", `ba:${epic.key}:E2-FR1`);
    const repo = mkdtempSync(join(tmpdir(), "praxis-jira-"));
    const spec = {
      logicalId: "E2-FR1",
      artifactId: `ba:${epic.key}:E2-FR1`,
      summary: "Counter library: add reset()",
      userStory: "As a developer I want reset So that zero",
      acceptanceCriteria: "Given When Then",
      requirementIds: ["E2-FR1"],
    };
    const before = state.createIssueCount;
    await expect(
      baAnalyzeEpic({
        provider,
        epicKey: epic.key,
        repo,
        stories: [spec],
        hooks: { crashAfterProperty: true },
      }),
    ).rejects.toThrow(/injected crash/);
    const mid = state.createIssueCount;
    const retry = await baAnalyzeEpic({
      provider,
      epicKey: epic.key,
      repo,
      stories: [spec],
    });
    expect(state.createIssueCount).toBe(mid);
    expect(state.createIssueCount).toBe(before);
    expect(retry.created).toEqual([]);
    expect(retry.handoff.canonicalStoryKeys).toContain(canon.key);
    expect(retry.handoff.readyForArchitecture).toBe(true);
    const comments = await provider.getComments(epic.key);
    const handoffs = comments.filter((c) =>
      JSON.stringify(c.body).includes("Praxis BA handoff ready"),
    );
    expect(handoffs).toHaveLength(1);
    const again = await baAnalyzeEpic({
      provider,
      epicKey: epic.key,
      repo,
      stories: [spec],
    });
    const comments2 = await provider.getComments(epic.key);
    expect(
      comments2.filter((c) => JSON.stringify(c.body).includes("Praxis BA handoff ready")),
    ).toHaveLength(1);
    expect(again.created).toEqual([]);
  });
});



