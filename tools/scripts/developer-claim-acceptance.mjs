#!/usr/bin/env node
/**
 * Developer claim + Jira transition resolution acceptance (no live Jira).
 */
import { createHash } from "node:crypto";
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
import { createFixtureJiraProvider, createMockFetch, createMockJiraState, LOCALIZED_RU_TRANSITIONS } from "@praxis/jira";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function sha(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const built = spawnSync(
  "npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira -w @praxis/cli -w @praxis/mcp",
  { cwd: root, shell: true, encoding: "utf8" },
);
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);

const { developerClaimOp, developerStatusOp, architectPreviewOp, architectApplyOp, PraxisOpError } =
  await import("@praxis/cli/operations");
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

function writeProductFiles(repo) {
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "counter.js"), "export function inc(n) { return n + 1; }\n");
  writeFileSync(
    join(repo, "src", "counter.test.js"),
    "import { inc } from './counter.js';\n",
  );
  return {
    js: sha(join(repo, "src", "counter.js")),
    test: sha(join(repo, "src", "counter.test.js")),
  };
}

function assertProductUntouched(repo, hashes) {
  if (sha(join(repo, "src", "counter.js")) !== hashes.js) fail("src/counter.js was modified");
  if (sha(join(repo, "src", "counter.test.js")) !== hashes.test) {
    fail("src/counter.test.js was modified");
  }
}

function claimArtifacts(repo, wpKey) {
  const localPath = join(repo, "work-packages", WP_ID, "manifest.json");
  const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : {};
  let journalHasClaim = false;
  const journalPath = join(repo, ".praxis-jira", "journal.json");
  if (existsSync(journalPath)) {
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journalHasClaim = Array.isArray(journal)
      ? journal.some((e) => /claim/i.test(e.operationId ?? "") || /claim/i.test(e.kind ?? ""))
      : false;
  }
  return {
    localClaim: local.claim ?? null,
    claimFile: existsSync(join(repo, ".praxis-jira", "claims", `${wpKey}.json`)),
    journalHasClaim,
  };
}

async function setupReady(overrides = {}) {
  const state = createMockJiraState({
    availableTransitions: overrides.availableTransitions,
    transitionPostStatus: overrides.transitionPostStatus,
  });
  const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
  const seeded = await seedCanonicalJira(fetchImpl);
  const repo = mkdtempSync(join(tmpdir(), "praxis-accept-claim-"));
  writeCanonicalRepo(repo);
  const hashes = writeProductFiles(repo);
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
  if (applied.readyForDevelopment !== true) fail("readyForDevelopment must be true");
  const wp = (applied.workPackages ?? []).find((w) => w.id === WP_ID);
  if (!wp?.jiraIssueKey || wp.jiraIssueKey === "PLANNED") {
    fail(`missing Jira WP key: ${JSON.stringify(applied.workPackages)}`);
  }
  const claimProvider = createFixtureJiraProvider({
    config: { ...JIRA_CFG, transitions: overrides.transitions ?? {} },
    fetchImpl,
  });
  return { state, fetchImpl, seeded, repo, hashes, wpKey: wp.jiraIssueKey, claimProvider, applied };
}

const proven = [];

{
  const { state, repo, hashes, wpKey, claimProvider } = await setupReady();
  const beforePosts = state.transitionPosts.length;
  const claimed = await developerClaimOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    provider: claimProvider,
  });
  if (!claimed || claimed.state !== "active") fail(`A: claim failed ${JSON.stringify(claimed)}`);
  const posts = state.transitionPosts.slice(beforePosts);
  if (!posts.length) fail("A: expected transition POST");
  for (const post of posts) {
    const id = post.body?.id;
    if (typeof id !== "string" || !/^\d+$/.test(id)) {
      fail(`A: POST used non-numeric id ${JSON.stringify(post.body)}`);
    }
    if (post.body?.name) fail(`A: POST included transition name ${post.body.name}`);
  }
  if (!posts.some((p) => p.body?.id === "21")) fail("A: expected discovered id 21");
  const status = await developerStatusOp({ repo, wp: WP_ID, provider: claimProvider });
  if (status.jiraIssueKey !== wpKey) fail(`A: status key ${status.jiraIssueKey}`);
  if (!Array.isArray(status.availableTransitions)) fail("A: missing availableTransitions");
  assertProductUntouched(repo, hashes);
  proven.push("A discovered numeric transition");
}

{
  const { state, repo, hashes, claimProvider } = await setupReady({
    availableTransitions: LOCALIZED_RU_TRANSITIONS,
  });
  await developerClaimOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    provider: claimProvider,
  });
  if (!state.transitionPosts.some((p) => p.body?.id === "21")) {
    fail("B: localized workflow did not resolve id 21");
  }
  assertProductUntouched(repo, hashes);
  proven.push("B localized transition name");
}

{
  const { state, repo, hashes, wpKey, claimProvider } = await setupReady({
    availableTransitions: [
      {
        id: "31",
        name: "Готово",
        to: { name: "Готово", statusCategory: { key: "done" } },
      },
    ],
  });
  for (const issue of state.issues.values()) {
    if (issue.issueType === "Epic") continue;
    issue.status = "В работе";
    issue.statusCategory = "indeterminate";
  }
  const before = state.transitionPosts.length;
  const claimed = await developerClaimOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    provider: claimProvider,
  });
  if (claimed.state !== "active") fail("C: claim should succeed when already in development");
  if (state.transitionPosts.length !== before) fail("C: must not re-transition");
  const artifacts = claimArtifacts(repo, wpKey);
  if (!artifacts.claimFile) fail("C: expected local claim artifact");
  assertProductUntouched(repo, hashes);
  proven.push("C already in target status");
}

{
  const { state, repo, hashes, wpKey, claimProvider } = await setupReady({
    availableTransitions: [
      {
        id: "31",
        name: "Готово",
        to: { name: "Готово", statusCategory: { key: "done" } },
      },
    ],
  });
  try {
    await developerClaimOp({
      repo,
      wp: WP_ID,
      confirmation: "YES",
      provider: claimProvider,
    });
    fail("D: expected JIRA_TRANSITION_NOT_AVAILABLE");
  } catch (e) {
    if (!(e instanceof PraxisOpError) || e.code !== "JIRA_TRANSITION_NOT_AVAILABLE") {
      fail(`D: expected JIRA_TRANSITION_NOT_AVAILABLE, got ${e instanceof Error ? e.message : e}`);
    }
    if (!e.details?.issueKey || e.details.semanticAction !== "START_DEVELOPMENT") {
      fail(`D: missing diagnostics ${JSON.stringify(e.details)}`);
    }
    if (!Array.isArray(e.details.available)) fail("D: missing available transitions");
  }
  if (await claimProvider.getIssueProperty(wpKey, "praxis.claim")) {
    fail("D: Jira claim property must remain null");
  }
  const artifacts = claimArtifacts(repo, wpKey);
  if (artifacts.localClaim || artifacts.claimFile || artifacts.journalHasClaim) {
    fail(`D: partial claim ${JSON.stringify(artifacts)}`);
  }
  if (state.transitionPosts.length) fail("D: must not POST");
  assertProductUntouched(repo, hashes);
  proven.push("D missing transition");
}

{
  const { state, repo, hashes, wpKey, claimProvider } = await setupReady({
    transitions: { "in-progress": "In Progress" },
  });
  try {
    await developerClaimOp({
      repo,
      wp: WP_ID,
      confirmation: "YES",
      provider: claimProvider,
    });
    fail("E: expected JIRA_TRANSITION_ID_INVALID");
  } catch (e) {
    if (!(e instanceof PraxisOpError) || e.code !== "JIRA_TRANSITION_ID_INVALID") {
      fail(`E: expected JIRA_TRANSITION_ID_INVALID, got ${e instanceof Error ? e.message : e}`);
    }
    if (e.details?.resolvedValue !== "In Progress") {
      fail(`E: resolvedValue ${JSON.stringify(e.details)}`);
    }
  }
  if (state.transitionPosts.length) fail("E: non-numeric id reached POST");
  if (await claimProvider.getIssueProperty(wpKey, "praxis.claim")) fail("E: claim persisted");
  assertProductUntouched(repo, hashes);
  proven.push("E invalid non-numeric id");
}

{
  const { state, repo, hashes, claimProvider } = await setupReady();
  const first = await developerClaimOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    provider: claimProvider,
  });
  const afterFirst = state.transitionPosts.length;
  const second = await developerClaimOp({
    repo,
    wp: WP_ID,
    confirmation: "YES",
    provider: claimProvider,
  });
  if (second.claimToken !== first.claimToken) fail("F: same actor must be idempotent");
  if (state.transitionPosts.length !== afterFirst) fail("F: rerun must not re-transition");
  assertProductUntouched(repo, hashes);
  proven.push("F same actor idempotent");
}

{
  const { repo, hashes, wpKey, claimProvider } = await setupReady();
  const { claimWorkPackage } = await import("@praxis/jira/workflow");
  await claimWorkPackage({
    provider: claimProvider,
    wpKey,
    repo,
    actor: "dev-a",
    accountId: "acct-a",
  });
  try {
    await developerClaimOp({
      repo,
      wp: WP_ID,
      confirmation: "YES",
      provider: claimProvider,
    });
    fail("G: expected WORK_PACKAGE_ALREADY_CLAIMED");
  } catch (e) {
    if (!(e instanceof PraxisOpError) || e.code !== "WORK_PACKAGE_ALREADY_CLAIMED") {
      fail(`G: expected WORK_PACKAGE_ALREADY_CLAIMED, got ${e instanceof Error ? e.message : e}`);
    }
  }
  assertProductUntouched(repo, hashes);
  proven.push("G different actor conflict");
}

{
  const { repo, hashes, wpKey, claimProvider } = await setupReady({
    transitionPostStatus: 400,
  });
  try {
    await developerClaimOp({
      repo,
      wp: WP_ID,
      confirmation: "YES",
      provider: claimProvider,
    });
    fail("H: expected transition POST failure");
  } catch {
    /* HTTP 400 after a valid id */
  }
  if (await claimProvider.getIssueProperty(wpKey, "praxis.claim")) {
    fail("H: Jira claim property must remain null");
  }
  const artifacts = claimArtifacts(repo, wpKey);
  if (artifacts.localClaim || artifacts.claimFile || artifacts.journalHasClaim) {
    fail(`H: partial claim ${JSON.stringify(artifacts)}`);
  }
  assertProductUntouched(repo, hashes);
  proven.push("H transition failure no partial claim");
}

await packClaudeExtension(version);
const { mcpbPath } = await ensurePackedExtension(root, version);
const { state, fetchImpl, seeded, repo, hashes, wpKey } = await setupReady();
const httpd = await startMockJiraHttp(fetchImpl);
const outside = mkdtempSync(join(tmpdir(), "praxis-claim-mcpb-"));
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
  if (!(listed.tools ?? []).some((t) => t.name === "praxis_developer_claim")) {
    fail("MCPB missing praxis_developer_claim");
  }
  const statusRaw = await session.client.callTool({
    name: "praxis_developer_status",
    arguments: { workPackage: WP_ID, repo },
  });
  const statusEnv = parseDoctorEnvelope(statusRaw);
  if (!statusEnv?.ok) fail(`MCPB status failed ${JSON.stringify(statusEnv)}`);
  if (statusEnv.data?.jiraIssueKey !== wpKey) {
    fail(`MCPB status key ${statusEnv.data?.jiraIssueKey} != ${wpKey}`);
  }
  const claimRaw = await session.client.callTool({
    name: "praxis_developer_claim",
    arguments: { workPackage: WP_ID, repo, confirmation: "YES" },
  });
  const claimEnv = parseDoctorEnvelope(claimRaw);
  if (!claimEnv?.ok) fail(`MCPB claim failed ${JSON.stringify(claimEnv)}`);
  if (claimEnv.data?.state !== "active") fail(`MCPB claim state ${JSON.stringify(claimEnv)}`);
  if (!state.transitionPosts.some((p) => p.body?.id === "21" && !p.body?.name)) {
    fail(`MCPB POST did not use discovered id: ${JSON.stringify(state.transitionPosts)}`);
  }
  if (JSON.stringify(claimEnv).includes("quality_status") || JSON.stringify(claimEnv).includes("8792")) {
    fail("MCPB claim depends on Quality");
  }
  assertProductUntouched(repo, hashes);
  proven.push("MCPB praxis_developer_claim");
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
    },
    null,
    2,
  ),
);
