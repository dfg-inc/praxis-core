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
  "npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira -w @praxis/cli -w @praxis/mcp",
  { cwd: root, shell: true, encoding: "utf8" },
);
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);
console.error("quality-apply: build ok");

const {
  qualityApplyPreviewOp,
  qualityApplyOp,
  PraxisOpError,
} = await import("@praxis/cli/operations");
const { writeQualityEvidence } = await import("@praxis/jira/workflow");
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
proven.push("A-C preview read-only fingerprint");
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
console.error("quality-apply: apply start");
const preview2 = await qualityApplyPreviewOp({ repo, wp: WP, provider });
const applied = await qualityApplyOp({
  repo,
  wp: WP,
  provider,
  confirmation: "YES",
  previewFingerprint: preview2.previewFingerprint,
});
if (!applied.ok) fail(`H: apply failed ${JSON.stringify(applied)}`);
if ((applied.bugsCreated ?? []).length) fail("N: bugs on PASS");
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
proven.push("H-M approved apply / report / comment / local state");

const retry = await qualityApplyOp({
  repo,
  wp: WP,
  provider,
  confirmation: "YES",
  previewFingerprint: preview2.previewFingerprint,
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
const failApply = await qualityApplyOp({
  repo: failRepo,
  wp: WP,
  provider: failProvider,
  confirmation: "YES",
  previewFingerprint: failPreview.previewFingerprint,
});
if (!failApply.ok) fail(`O: fail apply ${JSON.stringify(failApply)}`);
if (failApply.bugsCreated.length !== 1) fail("O: bug not created");
const failIssue = await failProvider.getIssue(failWp.key);
if (failIssue.statusCategory === "done") fail("O: FAILED review moved to Done");
const failPreview2 = await qualityApplyPreviewOp({ repo: failRepo, wp: WP, provider: failProvider });
const failApply2 = await qualityApplyOp({
  repo: failRepo,
  wp: WP,
  provider: failProvider,
  confirmation: "YES",
  previewFingerprint: failPreview2.previewFingerprint,
});
const bugs = [...failState.issues.values()].filter((i) => i.semanticType === "bug" || i.issueType === "Баг" || i.issueTypeId === "10012");
if (bugs.length !== 1) fail(`P: bug dedupe ${bugs.length}`);
if (bugs[0].issueTypeId !== "10012") fail("O: used display name as type id");
proven.push("O-P failed review bugs / no Done / dedupe");
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
