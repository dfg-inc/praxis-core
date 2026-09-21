#!/usr/bin/env node
/**
 * Developer complete + Quality handoff acceptance (no live Jira).
 * Covers A–M including MCPB complete. Does not mutate live PRX-* issues.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
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

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function freePort() {
  const { createServer } = await import("node:net");
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

const built = spawnSync(
  "npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira -w @praxis/quality-service -w @praxis/cli -w @praxis/mcp",
  { cwd: root, shell: true, encoding: "utf8" },
);
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);

const {
  developerClaimOp,
  developerCompleteOp,
  developerCompleteRecoveryPreviewOp,
  developerCompleteRecoveryApplyOp,
  developerStatusOp,
  qualityReviewOp,
  PraxisOpError,
} = await import("@praxis/cli/operations");
const {
  seedCanonicalJira,
  writeCanonicalRepo,
  startMockJiraHttp,
  WP_ID,
  JIRA_CFG,
} = await import("./preview-fixture.mjs");
const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
const { ensurePackedExtension, extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
const {
  connectOfficialMcp,
  hostedCleanEnv,
  parseDoctorEnvelope,
  MCP_STARTUP_BUDGET_MS,
  versionNegotiationModern,
} = await import("./official-mcp-client.mjs");

const PASSING_TEST = "node _praxis_verify.mjs";
const FAILING_TEST = "node _praxis_fail.mjs";

function writeProject(repo, testCmd) {
  if (testCmd === PASSING_TEST) {
    writeFileSync(join(repo, "_praxis_verify.mjs"), "console.log('Tests 5 passed'); process.exit(0);\n");
  }
  if (testCmd === FAILING_TEST) {
    writeFileSync(join(repo, "_praxis_fail.mjs"), "process.exit(1);\n");
  }
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
  test: ${testCmd}
`,
  );
}

function enrichChangeSpec(repo) {
  const p = join(repo, "design", WP_ID, "change-spec.json");
  const spec = JSON.parse(readFileSync(p, "utf8"));
  spec.requirementIds = ["E2-FR1"];
  spec.features = [
    { id: "FEAT-RESET-IMPL", title: "reset() implementation", readyForDev: true },
    { id: "FEAT-RESET-TESTS", title: "reset() tests", readyForDev: true },
  ];
  spec.acceptanceChecks = [
    { file: "src/counter.js", contains: "function reset" },
    { file: "src/counter.js", contains: "return 0" },
    { file: "src/counter.test.js", contains: "reset" },
    { type: "npm-test" },
  ];
  writeFileSync(p, `${JSON.stringify(spec, null, 2)}\n`);
}

async function setupReady() {
  const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
  const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
  const seeded = await seedCanonicalJira(fetchImpl);
  const repo = mkdtempSync(join(tmpdir(), "praxis-accept-complete-"));
  writeCanonicalRepo(repo);
  writeProject(repo, PASSING_TEST);
  enrichChangeSpec(repo);
  const { architectPreviewOp, architectApplyOp } = await import("@praxis/cli/operations");
  const preview = await architectPreviewOp({
    repo,
    epic: seeded.epicKey,
    provider: seeded.provider,
    wp: WP_ID,
  });
  if (!preview.ok) fail(`architect preview failed: ${JSON.stringify(preview)}`);
  const applied = await architectApplyOp({
    repo,
    epic: seeded.epicKey,
    provider: seeded.provider,
    wp: WP_ID,
    confirmation: "YES",
    previewFingerprint: preview.previewFingerprint,
  });
  if (!applied.ok) fail(`architect apply failed: ${JSON.stringify(applied)}`);
  const wp = (applied.workPackages ?? []).find((w) => w.id === WP_ID);
  if (!wp?.jiraIssueKey) fail(`missing Jira WP: ${JSON.stringify(applied.workPackages)}`);
  const provider = createJiraProvider({ config: JIRA_CFG, fetchImpl });
  await developerClaimOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    provider,
  });
  return { state, fetchImpl, seeded, repo, wpKey: wp.jiraIssueKey, provider };
}

function evidencePaths(repo) {
  return {
    evidence: join(repo, "design", WP_ID, "dev", "completion-evidence.json"),
    handoff: join(repo, "design", WP_ID, "dev", "quality-handoff.json"),
  };
}

const proven = [];

{
  const { state, repo, wpKey, provider } = await setupReady();
  const beforeDone = state.transitionPosts.filter((p) => p.body?.id === "31").length;
  const result = await developerCompleteOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    provider,
  });
  if (result.completed !== true) fail(`A: completed ${JSON.stringify(result)}`);
  if (result.workPackageId !== WP_ID) fail("A: workPackageId");
  if (result.jiraWorkPackageKey !== wpKey) fail("A: jira key");
  if (result.implementationState !== "complete") fail("A: implementationState");
  if (result.readyForQuality !== true) fail("A: readyForQuality");
  if (result.qualityStarted !== false) fail("A: qualityStarted");
  if (result.qualityApproved !== false) fail("A: qualityApproved");
  if (result.claimState !== "active") fail("A: claimState");
  if (result.jiraStatusCategory === "done") fail("B: Jira moved to Done");
  const issue = await provider.getIssue(wpKey);
  if (issue.statusCategory === "done") fail("B: getIssue Done");
  const afterDone = state.transitionPosts.filter((p) => p.body?.id === "31").length;
  if (afterDone !== beforeDone) fail("B: POST 31 Готово during complete");
  const paths = evidencePaths(repo);
  if (!existsSync(paths.evidence)) fail("C: missing completion evidence");
  const evidence = JSON.parse(readFileSync(paths.evidence, "utf8"));
  if (evidence.contract !== "developer.completion.evidence") fail("C: evidence contract");
  if (evidence.jiraWorkPackageKey !== wpKey) fail("C: evidence jira key");
  if (!evidence.canonicalStoryKeys?.length) fail("C: story keys");
  if (!evidence.requirementIds?.includes("E2-FR1")) fail("C: requirementIds");
  if (evidence.verification?.command !== PASSING_TEST) fail("D: test command");
  if (evidence.verification?.passed !== 5) fail(`D: passed ${evidence.verification?.passed}`);
  if (evidence.verification?.failed !== 0) fail("D: failed count");
  if (!existsSync(paths.handoff)) fail("E: missing quality handoff");
  const handoff = JSON.parse(readFileSync(paths.handoff, "utf8"));
  if (handoff.contract !== "developer.quality.handoff") fail("E: handoff contract");
  if (handoff.workPackageId !== WP_ID) fail("E: handoff WP");
  if (result.qualityStarted !== false || result.qualityApproved !== false) fail("F/G: quality started/approved");
  const claim = await provider.getIssueProperty(wpKey, "praxis.claim");
  if (claim?.state !== "active") fail(`H: persisted claim.state ${claim?.state}`);
  const status = await developerStatusOp({ repo, wp: WP_ID, provider });
  if (status.claimState && status.claimState !== "active") {
    fail(`H: status claimState ${status.claimState} contradicts disk`);
  }
  if (status.implementationState !== "complete") fail("H: status implementationState");
  if (status.readyForQuality !== true) fail("H: status readyForQuality");
  proven.push("A-H successful complete / in-progress / evidence / handoff / consistency");
}

{
  const { state, repo, wpKey, provider } = await setupReady();
  writeProject(repo, FAILING_TEST);
  try {
    await developerCompleteOp({ repo, wp: WP_ID, confirmation: "YES", provider });
    fail("I: expected VERIFICATION_FAILED");
  } catch (e) {
    if (!(e instanceof PraxisOpError) || e.code !== "VERIFICATION_FAILED") {
      fail(`I: expected VERIFICATION_FAILED, got ${e instanceof Error ? e.message : e}`);
    }
  }
  const paths = evidencePaths(repo);
  if (existsSync(paths.handoff)) fail("I: handoff written after failed tests");
  const issue = await provider.getIssue(wpKey);
  if (issue.statusCategory === "done") fail("I: Jira Done after failed tests");
  if (state.transitionPosts.some((p) => p.body?.id === "31")) fail("I: Done transition posted");
  proven.push("I test failure blocks completion");
}

{
  const { repo, wpKey, provider } = await setupReady();
  mkdirSync(join(repo, "design", WP_ID, "dev"), { recursive: true });
  mkdirSync(join(repo, "design", WP_ID, "dev", "quality-handoff.json"));
  try {
    await developerCompleteOp({ repo, wp: WP_ID, confirmation: "YES", provider });
    fail("J: expected HANDOFF_FAILED");
  } catch (e) {
    if (!(e instanceof PraxisOpError) || e.code !== "HANDOFF_FAILED") {
      fail(`J: expected HANDOFF_FAILED, got ${e instanceof Error ? e.message : e}`);
    }
  }
  const issue = await provider.getIssue(wpKey);
  if (issue.statusCategory === "done") fail("J: Jira Done after handoff failure");
  proven.push("J handoff failure blocks completion");
}

{
  const { state, repo, wpKey, provider } = await setupReady();
  const first = await developerCompleteOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    provider,
  });
  const posts = state.transitionPosts.length;
  const second = await developerCompleteOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    provider,
  });
  if (second.workPackageId !== first.workPackageId) fail("K: WP changed");
  if (second.qualityHandoffPath !== first.qualityHandoffPath) fail("K: handoff path changed");
  if (second.idempotent !== true) fail("K: expected idempotent");
  if (state.transitionPosts.length !== posts) fail("K: extra transition on rerun");
  if (second.claimState !== "active") fail("K: claim");
  proven.push("K idempotent rerun");
}

{
  const { state, repo, wpKey, provider } = await setupReady();
  for (const issue of state.issues.values()) {
    if (issue.key !== wpKey) continue;
    issue.status = "Готово";
    issue.statusCategory = "done";
  }
  try {
    await developerCompleteOp({ repo, wp: WP_ID, confirmation: "YES", provider });
    fail("L: complete must refuse premature Done");
  } catch (e) {
    if (!(e instanceof PraxisOpError) || e.code !== "PREMATURE_JIRA_DONE") {
      fail(`L: expected PREMATURE_JIRA_DONE, got ${e instanceof Error ? e.message : e}`);
    }
  }
  const preview = await developerCompleteRecoveryPreviewOp({
    repo,
    wp: WP_ID,
    provider,
  });
  if (!preview.needed || !preview.prematureDone) fail(`L: preview ${JSON.stringify(preview)}`);
  if (!preview.previewFingerprint) fail("L: missing fingerprint");
  const recovered = await developerCompleteRecoveryApplyOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    previewFingerprint: preview.previewFingerprint,
    provider,
  });
  if (recovered.completed !== true) fail("L: recovery apply");
  const issue = await provider.getIssue(wpKey);
  if (issue.statusCategory === "done") fail("L: still Done after recovery");
  const paths = evidencePaths(repo);
  if (!existsSync(paths.evidence) || !existsSync(paths.handoff)) fail("L: missing reconciled artifacts");
  process.env.PRAXIS_QUALITY_PORT = String(await freePort());
  const qa = await qualityReviewOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    provider,
  });
  if (!qa.developerEvidence?.hasQualityHandoff) fail("L: Quality cannot discover handoff");
  if (!qa.qualityInputs?.hasHandoff) fail("L: qualityInputs missing handoff");
  if (qa.jiraMutated !== false) fail("L: Quality review mutated Jira");
  const { stopQuality } = await import("../../packages/cli/dist/quality-ensure.js");
  stopQuality(repo);
  proven.push("L alpha.34 inconsistent-state recovery + Quality consumption");
}

await packClaudeExtension(version);
const { mcpbPath } = await ensurePackedExtension(root, version);
const { state, fetchImpl, repo, wpKey, provider } = await setupReady();
const httpd = await startMockJiraHttp(fetchImpl);
const outside = mkdtempSync(join(tmpdir(), "praxis-complete-mcpb-"));
const unpack = join(outside, "praxis-runtime");
mkdirSync(unpack, { recursive: true });
const extracted = extractMcpbRuntime(mcpbPath, unpack);
const env = {
  ...hostedCleanEnv(extracted.dest),
  PRAXIS_JIRA_MODE: "cloud",
  PRAXIS_JIRA_BASE_URL: httpd.baseUrl,
  PRAXIS_JIRA_EMAIL: "test@example.com",
  PRAXIS_JIRA_PROJECT_KEY: "PRX",
  PRAXIS_JIRA_TOKEN: "tok",
  PRAXIS_SKIP_DOTENV: "1",
};
let session;
try {
  session = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env,
    clientVersion: version,
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
  });
  const listed = await session.client.listTools();
  const names = (listed.tools ?? []).map((t) => t.name);
  if (!names.includes("praxis_developer_complete")) fail("MCPB missing praxis_developer_complete");
  const completeRaw = await session.client.callTool({
    name: "praxis_developer_complete",
    arguments: { workPackage: WP_ID, repo, confirmation: "YES" },
  });
  const completeEnv = parseDoctorEnvelope(completeRaw);
  if (!completeEnv?.ok) fail(`M: MCPB complete failed ${JSON.stringify(completeEnv)}`);
  if (completeEnv.data?.completed !== true) fail("M: completed");
  if (completeEnv.data?.readyForQuality !== true) fail("M: readyForQuality");
  if (completeEnv.data?.qualityStarted !== false) fail("M: qualityStarted");
  if (completeEnv.data?.jiraStatusCategory === "done") fail("M: MCPB marked Done");
  if (state.transitionPosts.some((p) => p.body?.id === "31")) fail("M: MCPB posted Готово");
  const paths = evidencePaths(repo);
  if (!existsSync(paths.evidence) || !existsSync(paths.handoff)) fail("M: MCPB missing files");
  if (JSON.stringify(completeEnv).includes("8792")) fail("M: Quality port leaked");
  proven.push("M final MCPB Developer complete");
} finally {
  if (session) await session.close();
  await httpd.close();
}

console.log(
  JSON.stringify(
    {
      ok: true,
      version,
      wp: WP_ID,
      jiraIssueKey: wpKey,
      proven,
      liveJiraMutated: false,
    },
    null,
    2,
  ),
);
