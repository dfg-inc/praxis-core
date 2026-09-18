#!/usr/bin/env node
/**
 * Canonical PRX-1 / PRX-3 / WP-20260914-002 preview fixture (no live Jira).
 */
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
} from "@praxis/jira";
import { baContentFingerprint } from "@praxis/jira/workflow";

export const WP_ID = "WP-20260914-002";

export const JIRA_CFG = {
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

const STORY_SPEC = {
  logicalId: "E2-FR1",
  summary: "Counter library: add reset() to return the counter to zero",
  userStory: "As a developer\n I want reset\n So that I can zero the counter",
  acceptanceCriteria: "Given a counter\nWhen reset\nThen value is 0",
  businessContext: "Counter library",
  requirementIds: ["E2-FR1"],
};

export function writeCanonicalRepo(repo) {
  writeFileSync(
    join(repo, ".project"),
    `stack:
  - node
  - javascript
requirementsFormat: user-story-gherkin
requiredArtifacts: []
environments: []
knowledge:
  ref: main
jira: {}
quality:
  test: npm test
`,
  );
  const design = join(repo, "design", WP_ID);
  mkdirSync(design, { recursive: true });
  writeFileSync(
    join(design, "index.md"),
    "# Counter Reset\n\nadd reset() to src/counter.js and one test in src/counter.test.js\n",
  );
  writeFileSync(join(design, "change-spec.json"), `${JSON.stringify({ id: WP_ID, files: ["src/counter.js", "src/counter.test.js"] }, null, 2)}\n`);
  writeFileSync(
    join(design, "architect-developer.handoff.json"),
    `${JSON.stringify({ contract: "architect.developer.handoff", version: "1.0.0", workPackageId: WP_ID }, null, 2)}\n`,
  );
  const proposalDir = join(repo, ".praxis-jira", "proposals");
  mkdirSync(proposalDir, { recursive: true });
  writeFileSync(
    join(proposalDir, "PRX-1.json"),
    `${JSON.stringify(
      {
        contract: "jira.ba.proposal",
        version: "1.0.0",
        epicKey: "PRX-1",
        stories: [
          {
            logicalId: "E2-FR1",
            artifactId: "ba:PRX-1:E2-FR1",
            summary: STORY_SPEC.summary,
            userStory: { asA: "developer", iWant: "reset", soThat: "I can zero the counter" },
            businessContext: STORY_SPEC.businessContext,
            acceptanceCriteria: [{ given: "a counter", when: "reset", then: "value is 0" }],
            outOfScope: [],
            dependencies: [],
            requirementIds: ["E2-FR1"],
          },
        ],
        nfrs: [],
        businessRules: [],
        openQuestions: [],
      },
      null,
      2,
    )}\n`,
  );
}

export async function seedCanonicalJira(fetchImpl) {
  const provider = createJiraProvider({ config: JIRA_CFG, fetchImpl });
  const epic = await provider.createIssue({ summary: "Counter management improvements", issueType: "Epic" });
  const dup = await provider.createIssue({
    summary: "[DUPLICATE — superseded by PRX-3] Counter library: add reset() to return the counter to zero",
    issueType: "Story",
    parentKey: epic.key,
    labels: ["praxis-duplicate"],
  });
  const canon = await provider.createIssue({
    summary: STORY_SPEC.summary,
    issueType: "Story",
    parentKey: epic.key,
    description: "User Story\nAcceptance Criteria\nRequirement IDs\nE2-FR1",
  });
  await provider.setIssueProperty(dup.key, "praxis.superseded", true);
  await provider.setIssueProperty(dup.key, "praxis.supersededBy", canon.key);
  await provider.setIssueProperty(canon.key, "praxis.artifactId", `ba:${epic.key}:E2-FR1`);
  await provider.setIssueProperty(canon.key, "praxis.managed", true);
  await provider.setIssueProperty(canon.key, "praxis.role", "ba");
  await provider.setIssueProperty(canon.key, "praxis.contentFingerprint", baContentFingerprint(STORY_SPEC));
  await provider.setIssueProperty(epic.key, "praxis.baHandoff", {
    contract: "jira.ba.architect.handoff",
    version: "1.0.0",
    epicKey: epic.key,
    storyKeys: [canon.key],
    canonicalStoryKeys: [canon.key],
    supersededStoryKeys: [dup.key],
    requirementIds: ["E2-FR1"],
    baArtifacts: [],
    openQuestions: [],
    nfrs: [],
    businessRules: [],
    constraints: [],
    acceptanceSummary: STORY_SPEC.acceptanceCriteria,
    dependencies: [],
    proposalReady: true,
    readyForArchitecture: true,
  });
  return { provider, epicKey: epic.key, dupKey: dup.key, canonKey: canon.key };
}

export function createCanonicalMock() {
  const state = createMockJiraState();
  const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
  return { state, fetchImpl };
}

export function startMockJiraHttp(fetchImpl) {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const host = req.headers.host || "127.0.0.1";
      const url = `http://${host}${req.url}`;
      const response = await fetchImpl(url, {
        method: req.method,
        headers: req.headers,
        body: body.length ? body : undefined,
      });
      res.statusCode = response.status;
      for (const [k, v] of response.headers.entries()) {
        if (k.toLowerCase() === "transfer-encoding") continue;
        res.setHeader(k, v);
      }
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err instanceof Error ? err.message : err));
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("mock Jira listen failed"));
        return;
      }
      resolve({
        server,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
