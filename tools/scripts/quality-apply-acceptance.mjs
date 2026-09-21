#!/usr/bin/env node
/**
 * Quality Apply acceptance. Mocked Jira only — does not mutate live PRX-*.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
  LOCALIZED_RU_TRANSITIONS,
} from "@praxis/jira";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const WP = "WP-20260914-002";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const built = spawnSync(
  "npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira -w @praxis/quality-service -w @praxis/cli -w @praxis/mcp",
  { cwd: root, shell: true, encoding: "utf8" },
);
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);
console.error("quality-apply: build ok");

const {
  qualityApplyPreviewOp,
  qualityApplyOp,
  PraxisOpError,
} = await import("@praxis/cli/operations");
const { writeQualityEvidence, applyQualityReview } = await import("@praxis/jira/workflow");
const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
const { ensurePackedExtension, extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
const {
  connectOfficialMcp,
  hostedCleanEnv,
  parseDoctorEnvelope,
  MCP_STARTUP_BUDGET_MS,
  versionNegotiationModern,
} = await import("./official-mcp-client.mjs");
const { JIRA_CFG, startMockJiraHttp } = await import("./preview-fixture.mjs");

function write(repo, rel, body) {
  const fp = join(repo, rel);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, body);
}

function seedRepo(repo, wpKey, extra = {}) {
  write(
    repo,
    `work-packages/${WP}/manifest.json`,
    JSON.stringify({ id: WP, jiraIssueKey: wpKey, qualityState: "pending", storyKeys: ["PRX-3"] }),
  );
  if (extra.src) write(repo, "src/counter.js", extra.src);
  writeQualityEvidence(repo, {
    reviewId: extra.reviewId ?? 3,
    workPackageId: WP,
    jiraWorkPackageKey: wpKey,
    canonicalStoryKeys: ["PRX-3"],
    requirementIds: ["E2-FR1"],
    verdict: extra.verdict ?? "PASSED",
    acceptanceChecks: extra.acceptanceChecks ?? [
      { id: "AC1", status: "PASSED" },
      { id: "AC2", status: "PASSED" },
      { id: "AC3", status: "PASSED" },
      { id: "AC4", status: "PASSED" },
    ],
    findings: extra.findings ?? [],
    snapshot: extra.snapshot ?? {
      digest: extra.digest,
      files: [{ path: "src/counter.js" }],
    },
  });
}

const { createHash } = await import("node:crypto");
function fileDigest(repo) {
  const abs = join(repo, "src/counter.js");
  const entries = [{ path: "src/counter.js", sha256: createHash("sha256").update(readFileSync(abs, "utf8")).digest("hex") }];
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

const proven = [];
const state = createMockJiraState({
  availableTransitions: LOCALIZED_RU_TRANSITIONS,
  issueTypes: [
    { id: "10000", name: "Эпик", hierarchyLevel: 1, subtask: false },
    { id: "10001", name: "История", hierarchyLevel: 0, subtask: false },
    { id: "10002", name: "Задача", hierarchyLevel: 0, subtask: false },
    { id: "10012", name: "Баг", hierarchyLevel: 0, subtask: false },
  ],
});
const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
const provider = createJiraProvider({ config: JIRA_CFG, fetchImpl });
const wp = await provider.createIssue({ summary: "WP reset", issueType: "Task" });
const story = await provider.createIssue({ summary: "Story", issueType: "Story" });
await provider.writePraxisState(wp.key, { qualityState: "pending" });
const repo = mkdtempSync(join(tmpdir(), "praxis-qapply-"));
const digest = (() => {
  write(repo, "src/counter.js", "export function reset() {\n  return 0;\n}\n");
  return fileDigest(repo);
})();
seedRepo(repo, wp.key, { digest, snapshot: { digest, files: [{ path: "src/counter.js" }] } });

console.error("quality-apply: preview start");
const preview = await qualityApplyPreviewOp({ repo, wp: WP, provider });
console.error("quality-apply: preview ok");
if (preview.jiraMutated !== false) fail("B: preview mutated Jira");
if (!preview.previewFingerprint?.startsWith("sha256:")) fail("C: missing fingerprint");
const transition = preview.plan.actions.find((a) => a.kind === "transition");
if (!/^\d+$/.test(String(transition?.transitionId ?? ""))) fail("I: transition id not discovered");
if (transition?.transitionId === "31" && transition?.transitionName !== "Готово") {
  /* 31 is valid if live discovery returned it; do not hardcode as the only allowed id */
}
if (preview.plan.bugsProposed !== 0) fail("N: PASS preview proposed bugs");
const disclosed = preview.plan.actions.map((a) => a.propertyKey).filter(Boolean);
if (!disclosed.includes("praxis.qualityAppliedReviewId") || !disclosed.includes("praxis.qualityCommentId")) {
  fail("O: preview missing bookkeeping properties");
}
if (!preview.plan.actions.some((a) => a.kind === "sqlite")) fail("O: preview missing SQLite action");
if (!preview.plan.currentStatus) fail("O: preview missing currentStatus");
proven.push("A-C preview read-only fingerprint");
proven.push("O preview discloses bookkeeping writes");
console.error("quality-apply: confirmation gates");

try {
  await qualityApplyOp({ repo, wp: WP, provider });
  fail("D: missing confirmation accepted");
} catch (e) {
  if (!(e instanceof PraxisOpError) || e.code !== "CONFIRMATION_REQUIRED") fail(`D: ${e}`);
}
try {
  await qualityApplyOp({ repo, wp: WP, provider, confirmation: "YES" });
  fail("E: missing fingerprint accepted");
} catch (e) {
  if (!(e instanceof PraxisOpError) || e.code !== "CONFIRMATION_REQUIRED") fail(`E: ${e}`);
}
try {
  await qualityApplyOp({
    repo,
    wp: WP,
    provider,
    confirmation: "YES",
    previewFingerprint: "sha256:deadbeef",
  });
  fail("F: stale fingerprint accepted");
} catch (e) {
  if (!(e instanceof PraxisOpError)) fail(`F: ${e}`);
}

write(repo, "src/counter.js", "export function reset() {\n  return 1;\n}\n");
try {
  await qualityApplyPreviewOp({ repo, wp: WP, provider });
  fail("G: changed source still previewed");
} catch (e) {
  if (!String(e).includes("QUALITY_REVIEW_STALE")) fail(`G: ${e}`);
}
write(repo, "src/counter.js", "export function reset() {\n  return 0;\n}\n");
console.error("quality-apply: snapshot freshness on apply");
{
  const snapWp = await provider.createIssue({ summary: "snapshot", issueType: "Task" });
  const snapRepo = mkdtempSync(join(tmpdir(), "praxis-qapply-snap-"));
  write(snapRepo, "src/counter.js", "export function reset() {\n  return 0;\n}\n");
  const snapDigest = fileDigest(snapRepo);
  seedRepo(snapRepo, snapWp.key, {
    digest: snapDigest,
    snapshot: { digest: snapDigest, files: [{ path: "src/counter.js" }] },
  });
  const snapPreview = await qualityApplyPreviewOp({ repo: snapRepo, wp: WP, provider });
  const commentsBeforeSnap = (await provider.getComments(snapWp.key)).length;
  write(snapRepo, "src/counter.js", "export function reset() {\n  return 9;\n}\n");
  try {
    await applyQualityReview({
      provider,
      repo: snapRepo,
      workPackageId: WP,
      previewFingerprint: snapPreview.previewFingerprint,
      syncQualityStore: async () => ({ ok: true }),
    });
    fail("F: changed snapshot still applied");
  } catch (e) {
    if (!String(e).includes("QUALITY_REVIEW_STALE") && !String(e).includes("QUALITY_PREVIEW_STALE") && !String(e).includes("QUALITY_FINGERPRINT")) {
      fail(`F: ${e}`);
    }
  }
  if ((await provider.getComments(snapWp.key)).length !== commentsBeforeSnap) {
    fail("F: wrote Jira after snapshot change");
  }
  proven.push("F product snapshot change rejected before writes");
}
console.error("quality-apply: drift checks");
{
  const driftWp = await provider.createIssue({ summary: "drift", issueType: "Task" });
  const driftRepo = mkdtempSync(join(tmpdir(), "praxis-qapply-drift-"));
  write(driftRepo, "src/counter.js", "export function reset() {\n  return 0;\n}\n");
  const driftDigest = fileDigest(driftRepo);
  seedRepo(driftRepo, driftWp.key, {
    digest: driftDigest,
    snapshot: { digest: driftDigest, files: [{ path: "src/counter.js" }] },
  });
  const driftPreview = await qualityApplyPreviewOp({ repo: driftRepo, wp: WP, provider });
  const commentsBeforeDrift = (await provider.getComments(driftWp.key)).length;
  state.issues.get(driftWp.key).status = "Blocked";
  try {
    await applyQualityReview({
      provider,
      repo: driftRepo,
      workPackageId: WP,
      previewFingerprint: driftPreview.previewFingerprint,
      syncQualityStore: async () => ({ ok: true }),
    });
    fail("B: status drift accepted");
  } catch (e) {
    if (!String(e).includes("QUALITY_PREVIEW_STALE")) fail(`B: ${e}`);
  }
  if ((await provider.getComments(driftWp.key)).length !== commentsBeforeDrift) {
    fail("B: wrote Jira after status drift");
  }
  state.issues.get(driftWp.key).status = driftPreview.plan.currentStatus;
  const idGone = [...LOCALIZED_RU_TRANSITIONS.filter((t) => t.id !== "31")];
  idGone.push({
    id: "41",
    name: "Закрыть",
    to: { id: "10009", name: "Закрыто", statusCategory: { key: "done", name: "Закрыто" } },
  });
  state.availableTransitions.splice(0, state.availableTransitions.length, ...idGone);
  try {
    await applyQualityReview({
      provider,
      repo: driftRepo,
      workPackageId: WP,
      previewFingerprint: driftPreview.previewFingerprint,
      syncQualityStore: async () => ({ ok: true }),
    });
    fail("C: missing approved transition accepted");
  } catch (e) {
    if (!String(e).includes("QUALITY_PREVIEW_STALE")) fail(`C: ${e}`);
  }
  state.availableTransitions.splice(0, state.availableTransitions.length, ...LOCALIZED_RU_TRANSITIONS);
  const retarget = LOCALIZED_RU_TRANSITIONS.map((t) =>
    t.id === "31"
      ? { ...t, to: { ...t.to, name: "Closed" } }
      : t,
  );
  state.availableTransitions.splice(0, state.availableTransitions.length, ...retarget);
  try {
    await applyQualityReview({
      provider,
      repo: driftRepo,
      workPackageId: WP,
      previewFingerprint: driftPreview.previewFingerprint,
      syncQualityStore: async () => ({ ok: true }),
    });
    fail("D: transition target change accepted");
  } catch (e) {
    if (!String(e).includes("QUALITY_PREVIEW_STALE")) fail(`D: ${e}`);
  }
  state.availableTransitions.splice(0, state.availableTransitions.length, ...LOCALIZED_RU_TRANSITIONS);
  proven.push("B-D Jira drift rejected before writes");
}

{
  const extraState = createMockJiraState({ availableTransitions: [...LOCALIZED_RU_TRANSITIONS] });
  const extraProvider = createJiraProvider({
    config: JIRA_CFG,
    fetchImpl: createMockFetch(extraState, { flavor: "cloud", projectKey: "PRX" }),
  });
  const extraWp = await extraProvider.createIssue({ summary: "extra-done", issueType: "Task" });
  const extraRepo = mkdtempSync(join(tmpdir(), "praxis-qapply-extra-"));
  write(extraRepo, "src/counter.js", "export function reset() {\n  return 0;\n}\n");
  const extraDigest = fileDigest(extraRepo);
  seedRepo(extraRepo, extraWp.key, {
    digest: extraDigest,
    snapshot: { digest: extraDigest, files: [{ path: "src/counter.js" }] },
  });
  const extraPreview = await qualityApplyPreviewOp({ repo: extraRepo, wp: WP, provider: extraProvider });
  const approvedId = extraPreview.plan.actions.find((a) => a.kind === "transition")?.transitionId;
  extraState.availableTransitions.push({
    id: "41",
    name: "Закрыть",
    to: { id: "10009", name: "Закрыто", statusCategory: { key: "done", name: "Закрыто" } },
  });
  const extraApply = await applyQualityReview({
    provider: extraProvider,
    repo: extraRepo,
    workPackageId: WP,
    previewFingerprint: extraPreview.previewFingerprint,
    syncQualityStore: async () => ({ ok: true }),
  });
  if (!extraApply.ok) fail(`E: extra Done apply failed ${JSON.stringify(extraApply)}`);
  const extraPosts = extraState.transitionPosts.filter((p) => p.key === extraWp.key);
  if (!extraPosts.some((p) => JSON.stringify(p.body).includes(`"${approvedId}"`))) {
    fail("E: approved transition not executed");
  }
  if (extraPosts.some((p) => JSON.stringify(p.body).includes('"41"'))) {
    fail("E: silently substituted another Done transition");
  }
  proven.push("E no silent Done substitution");
}

console.error("quality-apply: apply start");
const preview2 = await qualityApplyPreviewOp({ repo, wp: WP, provider });
const applied = await applyQualityReview({
  provider,
  repo,
  workPackageId: WP,
  previewFingerprint: preview2.previewFingerprint,
  syncQualityStore: async () => ({ ok: true }),
});
if (!applied.ok) fail(`H: apply failed ${JSON.stringify(applied)}`);
if ((applied.bugsCreated ?? []).length) fail("P: bugs on PASS");
if (applied.jiraTransitioned !== true) fail("A: not jiraTransitioned");
if (applied.localStateReconciled !== true) fail("L: local not reconciled");
const issue = await provider.getIssue(wp.key);
if (issue.statusCategory !== "done") fail("I: not Done after PASS apply");
const report = await provider.getIssueProperty(wp.key, "praxis.qualityReport");
if (!report) fail("J: missing QA report property");
const comments = await provider.getComments(wp.key);
if (!comments.some((c) => JSON.stringify(c.body ?? "").includes("Praxis: Quality report"))) {
  fail("K: missing managed comment");
}
const manifest = JSON.parse(readFileSync(join(repo, "work-packages", WP, "manifest.json"), "utf8"));
if (manifest.qualityState !== "approved") fail(`L: local qualityState ${manifest.qualityState}`);
if (!existsSync(join(repo, "design", WP, "qa", "quality-apply.json"))) fail("M: missing apply artifact");
const storyAfter = await provider.getIssue(story.key);
if (storyAfter.statusCategory === "done") fail("Q: unrelated Story moved to Done");
const storyReport = await provider.getIssueProperty(story.key, "praxis.qualityReport");
if (storyReport) fail("Q: unrelated Story received QA report");
proven.push("H-M approved apply / report / comment / local state");
proven.push("Q no unrelated Jira issues touched");

const retry = await applyQualityReview({
  provider,
  repo,
  workPackageId: WP,
  previewFingerprint: preview2.previewFingerprint,
  syncQualityStore: async () => ({ ok: true }),
});
if (!retry.alreadyApplied && (await provider.getComments(wp.key)).length !== comments.length) {
  fail("Q: duplicate comment on retry");
}
proven.push("Q comment idempotency");

const failState = createMockJiraState({
  availableTransitions: LOCALIZED_RU_TRANSITIONS,
  issueTypes: [
    { id: "10000", name: "Эпик", hierarchyLevel: 1, subtask: false },
    { id: "10001", name: "История", hierarchyLevel: 0, subtask: false },
    { id: "10002", name: "Задача", hierarchyLevel: 0, subtask: false },
    { id: "10012", name: "Баг", hierarchyLevel: 0, subtask: false },
  ],
});
const failFetch = createMockFetch(failState, { flavor: "cloud", projectKey: "PRX" });
const failProvider = createJiraProvider({ config: JIRA_CFG, fetchImpl: failFetch });
const failWp = await failProvider.createIssue({ summary: "WP fail", issueType: "Task" });
const failRepo = mkdtempSync(join(tmpdir(), "praxis-qapply-fail-"));
write(failRepo, "src/counter.js", "export function reset(){ return 0; }\n");
const failDigest = fileDigest(failRepo);
seedRepo(failRepo, failWp.key, {
  reviewId: 9,
  verdict: "FAILED",
  digest: failDigest,
  snapshot: { digest: failDigest, files: [{ path: "src/counter.js" }] },
  findings: [
    {
      fingerprint: "gap-1",
      blocking: true,
      summary: "AC1 missing snippet",
      acceptanceCheckId: "AC1",
    },
  ],
  acceptanceChecks: [{ id: "AC1", status: "FAILED" }],
});
const failPreview = await qualityApplyPreviewOp({ repo: failRepo, wp: WP, provider: failProvider });
if (failPreview.plan.actions.some((a) => a.kind === "transition")) fail("O: FAILED preview proposed Done");
if (failPreview.plan.bugsProposed !== 1) fail("O: missing bug proposal");
const failApply = await applyQualityReview({
  provider: failProvider,
  repo: failRepo,
  workPackageId: WP,
  previewFingerprint: failPreview.previewFingerprint,
  syncQualityStore: async () => ({ ok: true }),
});
if (!failApply.ok) fail(`O: fail apply ${JSON.stringify(failApply)}`);
if (failApply.bugsCreated.length !== 1) fail("O: bug not created");
const failIssue = await failProvider.getIssue(failWp.key);
if (failIssue.statusCategory === "done") fail("O: FAILED review moved to Done");
const failPreview2 = await qualityApplyPreviewOp({ repo: failRepo, wp: WP, provider: failProvider });
const failApply2 = await applyQualityReview({
  provider: failProvider,
  repo: failRepo,
  workPackageId: WP,
  previewFingerprint: failPreview2.previewFingerprint,
  syncQualityStore: async () => ({ ok: true }),
});
const bugs = [...failState.issues.values()].filter((i) => i.semanticType === "bug" || i.issueType === "Баг" || i.issueTypeId === "10012");
if (bugs.length !== 1) fail(`P: bug dedupe ${bugs.length}`);
if (bugs[0].issueTypeId !== "10012") fail("O: used display name as type id");
proven.push("O-P failed review bugs / no Done / dedupe");

{
  const partState = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
  const partProvider = createJiraProvider({
    config: JIRA_CFG,
    fetchImpl: createMockFetch(partState, { flavor: "cloud", projectKey: "PRX" }),
  });
  const partWp = await partProvider.createIssue({ summary: "partial", issueType: "Task" });
  const partRepo = mkdtempSync(join(tmpdir(), "praxis-qapply-part-"));
  write(partRepo, "src/counter.js", "export function reset() {\n  return 0;\n}\n");
  const partDigest = fileDigest(partRepo);
  seedRepo(partRepo, partWp.key, {
    digest: partDigest,
    snapshot: { digest: partDigest, files: [{ path: "src/counter.js" }] },
  });
  const partPreview = await qualityApplyPreviewOp({ repo: partRepo, wp: WP, provider: partProvider });
  partState.transitionPostStatus = 400;
  const part1 = await applyQualityReview({
    provider: partProvider,
    repo: partRepo,
    workPackageId: WP,
    previewFingerprint: partPreview.previewFingerprint,
    syncQualityStore: async () => ({ ok: true }),
  });
  if (part1.ok) fail("I: transition failure returned full success");
  if (!part1.partial) fail("I: expected partial");
  if (part1.pending.every((id) => !id.includes("transition"))) fail("I: transition not pending");
  partState.transitionPostStatus = 204;
  const part2 = await applyQualityReview({
    provider: partProvider,
    repo: partRepo,
    workPackageId: WP,
    previewFingerprint: partPreview.previewFingerprint,
    syncQualityStore: async () => ({ ok: true }),
  });
  if (!part2.ok) fail(`J: retry after partial failed ${JSON.stringify(part2)}`);
  const partComments = await partProvider.getComments(partWp.key);
  const part3 = await applyQualityReview({
    provider: partProvider,
    repo: partRepo,
    workPackageId: WP,
    previewFingerprint: partPreview.previewFingerprint,
    syncQualityStore: async () => ({ ok: true }),
  });
  if (!part3.alreadyApplied) fail("K: expected alreadyApplied after Done");
  if ((await partProvider.getComments(partWp.key)).length !== partComments.length) {
    fail("K: duplicate comment after Done");
  }
  proven.push("I-K partial retry and Done idempotency");
}

{
  const missWp = await provider.createIssue({ summary: "nomanifest", issueType: "Task" });
  const missRepo = mkdtempSync(join(tmpdir(), "praxis-qapply-noman-"));
  writeQualityEvidence(missRepo, {
    reviewId: 15,
    workPackageId: WP,
    jiraWorkPackageKey: missWp.key,
    verdict: "PASSED",
    snapshot: { digest: "", files: [] },
  });
  const missPreview = await qualityApplyPreviewOp({ repo: missRepo, wp: WP, provider });
  const missApply = await applyQualityReview({
    provider,
    repo: missRepo,
    workPackageId: WP,
    previewFingerprint: missPreview.previewFingerprint,
    syncQualityStore: async () => ({ ok: true }),
  });
  if (missApply.ok) fail("L: missing manifest returned success");
  if (missApply.code !== "QUALITY_MANIFEST_MISSING") fail(`L: ${missApply.code}`);
  proven.push("L missing manifest not committed");
}

{
  const sqlWp = await provider.createIssue({ summary: "sqlite", issueType: "Task" });
  const sqlRepo = mkdtempSync(join(tmpdir(), "praxis-qapply-sql-"));
  write(sqlRepo, "src/counter.js", "export function reset() {\n  return 0;\n}\n");
  const sqlDigest = fileDigest(sqlRepo);
  seedRepo(sqlRepo, sqlWp.key, {
    digest: sqlDigest,
    snapshot: { digest: sqlDigest, files: [{ path: "src/counter.js" }] },
  });
  const sqlPreview = await qualityApplyPreviewOp({ repo: sqlRepo, wp: WP, provider });
  const sql1 = await applyQualityReview({
    provider,
    repo: sqlRepo,
    workPackageId: WP,
    previewFingerprint: sqlPreview.previewFingerprint,
    syncQualityStore: async () => ({ ok: false, reason: "unavailable" }),
  });
  if (sql1.ok) fail("M: sqlite failure returned success");
  if (sql1.qualityStoreReconciled) fail("M: claimed sqlite reconciled");
  const sql2 = await applyQualityReview({
    provider,
    repo: sqlRepo,
    workPackageId: WP,
    previewFingerprint: sqlPreview.previewFingerprint,
    syncQualityStore: async () => ({ ok: true }),
  });
  if (!sql2.ok) fail(`M: sqlite retry ${JSON.stringify(sql2)}`);
  proven.push("M sqlite sync pending then retry");
}

{
  const { callTool } = await import("../../packages/mcp/dist/tools.js");
  const nState = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
  const nProvider = createJiraProvider({
    config: JIRA_CFG,
    fetchImpl: createMockFetch(nState, { flavor: "cloud", projectKey: "PRX" }),
  });
  const nWp = await nProvider.createIssue({ summary: "mcp-partial", issueType: "Task" });
  const nRepo = mkdtempSync(join(tmpdir(), "praxis-qapply-mcpn-"));
  write(nRepo, "src/counter.js", "export function reset() {\n  return 0;\n}\n");
  const nDigest = fileDigest(nRepo);
  seedRepo(nRepo, nWp.key, {
    digest: nDigest,
    snapshot: { digest: nDigest, files: [{ path: "src/counter.js" }] },
  });
  const nPreview = await qualityApplyPreviewOp({ repo: nRepo, wp: WP, provider: nProvider });
  nState.transitionPostStatus = 400;
  const nEnv = await callTool(
    "praxis_quality_apply",
    {
      workPackage: WP,
      repo: nRepo,
      confirmation: "YES",
      previewFingerprint: nPreview.previewFingerprint,
    },
    { role: "runtime", version, extra: { provider: nProvider } },
  );
  if (nEnv.ok !== false) fail(`N: MCP envelope ok=${nEnv.ok} ${JSON.stringify(nEnv)}`);
  if (nEnv.data?.ok !== false) fail(`N: data.ok not false ${JSON.stringify(nEnv)}`);
  proven.push("N MCP outer result reflects incomplete Apply");
}

if (process.env.PRAXIS_SKIP_MCPB === "1") {
  console.log(`PASS quality-apply ${proven.join("; ")} (MCPB skipped)`);
  process.exit(0);
}
console.error("quality-apply: packing MCPB");
await packClaudeExtension(version);
const { mcpbPath } = await ensurePackedExtension(root, version);
const outside = mkdtempSync(join(tmpdir(), "praxis-qapply-mcpb-"));
const unpack = join(outside, "praxis-runtime");
mkdirSync(unpack, { recursive: true });
const extracted = extractMcpbRuntime(mcpbPath, unpack);
const httpd = await startMockJiraHttp(fetchImpl);
const mcpRepo = mkdtempSync(join(tmpdir(), "praxis-qapply-mcp-"));
write(mcpRepo, "src/counter.js", "export function reset() {\n  return 0;\n}\n");
const mcpDigest = fileDigest(mcpRepo);
const mcpWp = await provider.createIssue({ summary: "MCP WP", issueType: "Task" });
seedRepo(mcpRepo, mcpWp.key, {
  reviewId: 12,
  digest: mcpDigest,
  snapshot: { digest: mcpDigest, files: [{ path: "src/counter.js" }] },
});
try {
  const session = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: {
      ...hostedCleanEnv(extracted.dest),
      PRAXIS_JIRA_MODE: "cloud",
      PRAXIS_JIRA_BASE_URL: httpd.baseUrl,
      PRAXIS_JIRA_EMAIL: "test@example.com",
      PRAXIS_JIRA_PROJECT_KEY: "PRX",
      PRAXIS_JIRA_TOKEN: "tok",
    },
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
    clientVersion: version,
  });
  try {
    const listed = await session.client.listTools();
    const names = listed.tools.map((t) => t.name);
    if (!names.includes("praxis_quality_apply_preview") || !names.includes("praxis_quality_apply")) {
      fail("MCPB missing apply tools");
    }
    const denied = await session.client.callTool({
      name: "praxis_quality_apply",
      arguments: { workPackage: WP, repo: mcpRepo },
    });
    const deniedEnv = parseDoctorEnvelope(denied);
    const deniedText = JSON.stringify(denied);
    const gated =
      deniedEnv?.code === "CONFIRMATION_REQUIRED" ||
      /expected "YES"|confirmation/i.test(deniedText);
    if (!gated) fail(`MCP apply confirmation ${deniedText}`);
  } finally {
    await session.close();
  }
} finally {
  await httpd.close();
  rmSync(outside, { recursive: true, force: true });
}

if (String(httpd.baseUrl).includes("praxis-integration-test.atlassian.net")) {
  fail("T: live Jira base");
}
proven.push("T no live Jira mutation in fixtures");
console.log(`PASS quality-apply ${proven.join("; ")}`);
