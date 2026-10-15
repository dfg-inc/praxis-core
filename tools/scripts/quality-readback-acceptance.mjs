#!/usr/bin/env node
/**
 * Quality Apply / Review read-back. Mocked Jira + local Quality HTTP. No live writes.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  createFixtureJiraProvider,
  createMockFetch,
  createMockJiraState,
  LOCALIZED_RU_TRANSITIONS,
} from "@praxis/jira";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WP = "WP-20260914-002";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const built = spawnSync(
  "npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira -w @praxis/quality-service -w @praxis/cli",
  { cwd: root, shell: true, encoding: "utf8" },
);
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);

const { qualityApplyStatusOp, qualityReviewShowOp, developerStatusOp } = await import("@praxis/cli/operations");
const {
  writeQualityEvidence,
  applyQualityReview,
  inspectQualityComments,
  QUALITY_COMMENT_MARK,
  QUALITY_COMMENT_PROP,
} = await import("@praxis/jira/workflow");
const { JIRA_CFG } = await import("./preview-fixture.mjs");
const { QualityStore } = await import("../../apps/quality-service/dist/store.js");
const { startServer } = await import("../../apps/quality-service/dist/server.js");

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolvePromise(port)));
    });
    server.on("error", reject);
  });
}

function write(repo, rel, body) {
  const fp = join(repo, rel);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}

const proven = [];
const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
const provider = createFixtureJiraProvider({
  config: JIRA_CFG,
  fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
});
const wp = await provider.createIssue({ summary: "WP", issueType: "Task" });
const other = await provider.createIssue({ summary: "other", issueType: "Task" });
const repo = mkdtempSync(join(tmpdir(), "praxis-qread-"));
write(repo, `work-packages/${WP}/manifest.json`, {
  id: WP,
  jiraIssueKey: wp.key,
  qualityState: "pending",
  implementationState: "complete",
  readyForQuality: true,
});
writeQualityEvidence(repo, {
  reviewId: 1,
  workPackageId: WP,
  jiraWorkPackageKey: wp.key,
  verdict: "PASSED",
  snapshot: { digest: "", files: [] },
});
await provider.writePraxisState(wp.key, { qualityState: "pending" });

const missing = await qualityReviewShowOp({ repo, wp: WP, reviewId: 1 });
if (missing.ok !== false || missing.code !== "QUALITY_RUNTIME_UNREACHABLE") {
  fail(`unavailable service ${JSON.stringify(missing)}`);
}
proven.push("unavailable Quality service");

const { qualityApplyPreviewOp } = await import("@praxis/cli/operations");
const preview = await qualityApplyPreviewOp({ repo, wp: WP, provider });
const applied = await applyQualityReview({
  provider,
  repo,
  workPackageId: WP,
  previewFingerprint: preview.previewFingerprint,
  syncQualityStore: async () => ({ ok: true }),
});
if (!applied.ok) fail(`apply ${JSON.stringify(applied)}`);

const comments = await inspectQualityComments({ provider, issueKey: wp.key, reviewId: 1 });
if (!comments.storedCommentIdPresent) fail("missing stored comment id property");
if (!comments.commentExists) fail("stored comment id not found on issue");
if (!comments.markerMatches || !comments.reviewIdMatches) fail("marker/review mismatch");
if (!comments.belongsToIssue) fail("comment not on PRX issue");
if (comments.matchingManagedCount !== 1) fail(`managed count ${comments.matchingManagedCount}`);
if (comments.duplicates) fail("duplicate managed comments");
const otherComments = await inspectQualityComments({ provider, issueKey: other.key, reviewId: 1 });
if (otherComments.matchingManagedCount !== 0) fail("unrelated issue comments");
proven.push("comment lookup by id / marker / issue / no duplicates");

for (let i = 0; i < 110; i += 1) {
  await provider.addComment(wp.key, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `noise ${i}` }] }] });
}
const paged = await inspectQualityComments({ provider, issueKey: wp.key, reviewId: 1 });
if (paged.matchingManagedCount !== 1) fail(`pagination lost managed comment ${paged.matchingManagedCount}`);
proven.push("comment pagination");

const applyStatus = await qualityApplyStatusOp({ repo, wp: WP, provider });
if (applyStatus.qualityState !== "approved") fail("apply status qualityState");
if (applyStatus.comments?.matchingManagedCount !== 1) fail("apply status comments");
if (applyStatus.jiraMutated !== false) fail("apply status mutated Jira");
const posts = state.transitionPosts.length;
await developerStatusOp({ repo, wp: WP, provider });
await qualityApplyStatusOp({ repo, wp: WP, provider });
if (state.transitionPosts.length !== posts) fail("read-back wrote transitions");
proven.push("apply status consistency / no writes");

{
  const ghost = await provider.createIssue({ summary: "ghost", issueType: "Task" });
  await provider.setIssueProperty(ghost.key, QUALITY_COMMENT_PROP, "99999");
  const ghostRead = await inspectQualityComments({ provider, issueKey: ghost.key, reviewId: 1 });
  if (ghostRead.storedCommentIdPresent !== true) fail("ghost property");
  if (ghostRead.commentExists) fail("property must not prove comment exists");
  proven.push("missing comment");
}

const port = await freePort();
const store = await QualityStore.create(":memory:");
store.addReview({
  mrRef: "wp:WP-20260914-002",
  projectId: WP,
  result: "PASSED",
  notes: JSON.stringify({
    kind: "work-package-review",
    workPackageId: WP,
    evidence: {
      workPackageId: WP,
      jiraWorkPackageKey: wp.key,
      verdict: "PASSED",
      acceptanceChecks: [{ id: "AC1", status: "PASSED" }],
      verification: { passed: 5, failed: 0 },
    },
  }),
});
const server = startServer({ store, port, host: "127.0.0.1" });
await new Promise((r) => setTimeout(r, 80));
const prevUrl = process.env.PRAXIS_QUALITY_URL;
process.env.PRAXIS_QUALITY_URL = `http://127.0.0.1:${port}/health`;
try {
  const none = await qualityReviewShowOp({ repo, wp: WP, reviewId: 99 });
  if (none.ok !== false || none.code !== "QUALITY_REVIEW_MISSING") fail(`missing review ${JSON.stringify(none)}`);
  proven.push("missing Review");
  const shown = await qualityReviewShowOp({ repo, wp: WP, reviewId: 1 });
  if (shown.ok !== true) fail(`show ${JSON.stringify(shown)}`);
  if (shown.reviewId !== 1) fail("review id");
  if (shown.applied !== false) fail("unapplied fabricated");
  if (shown.appliedAt) fail("fabricated appliedAt");
  if (shown.verdict !== "PASSED") fail("verdict");
  await fetch(`http://127.0.0.1:${port}/reviews/1/applied`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ previewFingerprint: preview.previewFingerprint }),
  });
  const appliedShow = await qualityReviewShowOp({ repo, wp: WP, reviewId: 1 });
  if (appliedShow.applied !== true) fail(`applied ${JSON.stringify(appliedShow)}`);
  if (typeof appliedShow.appliedAt !== "string") fail("appliedAt from storage");
  proven.push("storage-backed applied-state");
} finally {
  if (prevUrl === undefined) delete process.env.PRAXIS_QUALITY_URL;
  else process.env.PRAXIS_QUALITY_URL = prevUrl;
  store.close();
  await new Promise((res) => server.close(() => res()));
}

if (String(JIRA_CFG.baseUrl || "").includes("praxis-integration-test.atlassian.net")) fail("live Jira");
if (!QUALITY_COMMENT_MARK.includes("Quality")) fail("marker");
console.log(`PASS quality-readback ${proven.join("; ")}`);
