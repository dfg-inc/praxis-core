#!/usr/bin/env node
/**
 * Quality lifecycle consistency. Mocked Jira only — no live PRX-* writes.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  createFixtureJiraProvider,
  createMockFetch,
  createMockJiraState,
  LOCALIZED_RU_TRANSITIONS,
} from "@praxis/jira";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WP = "WP-20260914-002";
const SIBLING = "WP-20260914-999";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const built = spawnSync(
  "npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira -w @praxis/cli",
  { cwd: root, shell: true, encoding: "utf8" },
);
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);

const { developerStatusOp, qualityApplyStatusOp } = await import("@praxis/cli/operations");
const { writeQualityEvidence, applyQualityReview } = await import("@praxis/jira/workflow");
const { JIRA_CFG } = await import("./preview-fixture.mjs");

function write(repo, rel, body) {
  const fp = join(repo, rel);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}

function seedLocal(repo, wpKey, extra = {}) {
  write(repo, `work-packages/${WP}/manifest.json`, {
    id: WP,
    jiraIssueKey: wpKey,
    status: extra.status ?? "ready-for-qa",
    implementationState: extra.implementationState ?? "complete",
    readyForQuality: extra.readyForQuality ?? true,
    qualityState: extra.qualityState ?? "pending",
    claim: extra.claim ?? { state: "active", actor: "dev" },
  });
  write(repo, `design/${WP}/dev/completion-evidence.json`, { implementationStatus: "complete", readyForQuality: true });
  write(repo, `design/${WP}/dev/quality-handoff.json`, { contract: "developer.quality.handoff", workPackageId: WP });
  if (extra.review) {
    writeQualityEvidence(repo, extra.review);
  }
}

const proven = [];
const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
const provider = createFixtureJiraProvider({
  config: JIRA_CFG,
  fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
});
const wp = await provider.createIssue({ summary: "WP", issueType: "Task" });
const sibling = await provider.createIssue({ summary: "sibling", issueType: "Task" });
await provider.writePraxisState(wp.key, {
  lifecycle: "ready-for-qa",
  implementationState: "complete",
  readyForQuality: true,
  qualityState: "pending",
});
await provider.setIssueProperty(wp.key, "praxis.claim", { state: "active", actor: "dev" });
await provider.setIssueProperty(wp.key, "praxis.workPackageManifest", {
  id: WP,
  status: "ready-for-qa",
  claim: { state: "active" },
});
const repo = mkdtempSync(join(tmpdir(), "praxis-qstate-"));
seedLocal(repo, wp.key);
write(repo, `work-packages/${SIBLING}/manifest.json`, {
  id: SIBLING,
  jiraIssueKey: sibling.key,
  qualityState: "pending",
});
await provider.writePraxisState(sibling.key, { qualityState: "pending" });

const postsBefore = state.transitionPosts.length;
const statusA = await developerStatusOp({ repo, wp: WP, provider });
if (statusA.qualityState !== "pending") fail(`A: expected pending got ${statusA.qualityState}`);
if (statusA.implementationState !== "complete") fail("A: implementationState");
if (statusA.readyForQuality !== true) fail("A: readyForQuality");
proven.push("A developer ready-for-QA pending");

writeQualityEvidence(repo, {
  reviewId: 1,
  workPackageId: WP,
  jiraWorkPackageKey: wp.key,
  verdict: "PASSED",
  snapshot: { digest: "", files: [] },
});
const statusB = await developerStatusOp({ repo, wp: WP, provider });
if (statusB.qualityState !== "pending") fail(`B: review without apply should stay pending ${statusB.qualityState}`);
proven.push("B PASSED review not applied stays pending");

const applied = await applyQualityReview({
  provider,
  repo,
  workPackageId: WP,
  previewFingerprint: (await (await import("@praxis/cli/operations")).qualityApplyPreviewOp({ repo, wp: WP, provider }))
    .previewFingerprint,
  syncQualityStore: async () => ({ ok: true }),
});
if (!applied.ok) fail(`C: apply ${JSON.stringify(applied)}`);
const statusC = await developerStatusOp({ repo, wp: WP, provider });
if (statusC.qualityState !== "approved") fail(`D: developer_status ${statusC.qualityState}`);
const praxis = await provider.readPraxisState(wp.key);
if (praxis?.qualityState !== "approved") fail(`E: praxis.state ${praxis?.qualityState}`);
const manifest = JSON.parse(readFileSync(join(repo, "work-packages", WP, "manifest.json"), "utf8"));
if (manifest.qualityState !== "approved") fail(`F: local ${manifest.qualityState}`);
const stale = await provider.getIssueProperty(wp.key, "praxis.workPackageManifest");
if (stale?.qualityState === "approved") fail("G: test expected historical snapshot without qualityState");
if (statusC.qualityState !== "approved") fail("G: stale manifest overrode qualityState");
if (statusC.claimState !== "active") fail(`H: claim ${statusC.claimState}`);
const siblingStatus = await developerStatusOp({ repo, wp: SIBLING, provider });
if (siblingStatus.qualityState !== "pending") fail(`L: sibling ${siblingStatus.qualityState}`);
if (state.transitionPosts.length < postsBefore) fail("M: unexpected transition shrinkage");
const applyStatus = await qualityApplyStatusOp({ repo, wp: WP, provider });
if (applyStatus.qualityState !== "approved") fail("C: apply status not approved");
if (applyStatus.overallConsistency === "divergent") fail(`C: divergent ${JSON.stringify(applyStatus.qualityDiagnostics)}`);
proven.push("C-H apply committed / developer_status / Jira / local / claim");
proven.push("G stale workPackageManifest ignored");
proven.push("L sibling isolation");
proven.push("M status did not shrink Jira transition log");

{
  const partState = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
  const partProvider = createFixtureJiraProvider({
    config: JIRA_CFG,
    fetchImpl: createMockFetch(partState, { flavor: "cloud", projectKey: "PRX" }),
  });
  const partWp = await partProvider.createIssue({ summary: "partial", issueType: "Task" });
  const partRepo = mkdtempSync(join(tmpdir(), "praxis-qstate-part-"));
  seedLocal(partRepo, partWp.key);
  writeQualityEvidence(partRepo, {
    reviewId: 4,
    workPackageId: WP,
    jiraWorkPackageKey: partWp.key,
    verdict: "PASSED",
    snapshot: { digest: "", files: [] },
  });
  const { qualityApplyPreviewOp } = await import("@praxis/cli/operations");
  const preview = await qualityApplyPreviewOp({ repo: partRepo, wp: WP, provider: partProvider });
  partState.transitionPostStatus = 400;
  const part = await applyQualityReview({
    provider: partProvider,
    repo: partRepo,
    workPackageId: WP,
    previewFingerprint: preview.previewFingerprint,
    syncQualityStore: async () => ({ ok: true }),
  });
  if (part.ok) fail("I: partial returned success");
  const partStatus = await qualityApplyStatusOp({ repo: partRepo, wp: WP, provider: partProvider });
  if (partStatus.ok === true) fail("I: apply status claimed success");
  if (partStatus.applyPartial !== true && partStatus.overallConsistency !== "partial") {
    fail(`I: expected partial ${JSON.stringify(partStatus)}`);
  }
  partState.transitionPostStatus = 204;
  const retry = await applyQualityReview({
    provider: partProvider,
    repo: partRepo,
    workPackageId: WP,
    previewFingerprint: preview.previewFingerprint,
    syncQualityStore: async () => ({ ok: true }),
  });
  if (!retry.ok) fail(`J: retry ${JSON.stringify(retry)}`);
  proven.push("I-J partial not success then retry");
}

{
  const histWp = await provider.createIssue({ summary: "hist", issueType: "Task" });
  const histRepo = mkdtempSync(join(tmpdir(), "praxis-qstate-hist-"));
  write(histRepo, `work-packages/${WP}/manifest.json`, {
    id: WP,
    jiraIssueKey: histWp.key,
    status: "ready-for-qa",
  });
  write(histRepo, `design/${WP}/dev/completion-evidence.json`, { readyForQuality: true });
  write(histRepo, `design/${WP}/dev/quality-handoff.json`, { contract: "developer.quality.handoff" });
  await provider.writePraxisState(histWp.key, { qualityState: "approved", reviewId: 1, implementationState: "complete" });
  await provider.setIssueProperty(histWp.key, "praxis.workPackageManifest", { status: "ready-for-qa" });
  const hist = await developerStatusOp({ repo: histRepo, wp: WP, provider });
  if (hist.qualityState !== "approved") fail(`K: missing fields inferred pending ${hist.qualityState}`);
  proven.push("K historical manifest missing new fields");
}

if (String(JIRA_CFG.baseUrl || "").includes("praxis-integration-test.atlassian.net")) {
  fail("live Jira base");
}
console.log(`PASS quality-state-consistency ${proven.join("; ")}`);
