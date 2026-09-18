#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const built = spawnSync("npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira -w @praxis/cli", {
  cwd: root,
  shell: true,
  encoding: "utf8",
});
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);

const { architectPreviewOp, architectApplyOp, PraxisOpError } = await import("@praxis/cli/operations");
const { resolveRemoteWpKey } = await import("@praxis/jira/workflow");
const {
  createCanonicalMock,
  seedCanonicalJira,
  writeCanonicalRepo,
  WP_ID,
  HISTORICAL_WP_ID,
  LIVE_WP_TITLE,
} = await import("./preview-fixture.mjs");

function sha(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const { fetchImpl, state } = createCanonicalMock();
const seeded = await seedCanonicalJira(fetchImpl);
const repo = mkdtempSync(join(tmpdir(), "praxis-accept-wp-scope-"));
writeCanonicalRepo(repo);

const beforeHashes = {
  current: sha(join(repo, "wp", WP_ID, "index.md")),
  historical: sha(join(repo, "wp", HISTORICAL_WP_ID, "index.md")),
};

const preview = await architectPreviewOp({
  repo,
  epic: seeded.epicKey,
  provider: seeded.provider,
  wp: WP_ID,
});
if (!preview.ok) fail(`preview failed: ${JSON.stringify(preview)}`);
if (preview.readyForDevelopment !== false) fail("preview must keep readyForDevelopment=false");
const create = (preview.plan ?? []).filter((p) => p.action === "CREATE" && p.kind === "work-package");
if (create.length !== 1) fail(`expected CREATE 1, got ${JSON.stringify(create)}`);
if (create[0].localWorkPackageId !== WP_ID) fail(`wrong WP ${create[0].localWorkPackageId}`);
if (create[0].summary !== `[${WP_ID}] ${LIVE_WP_TITLE}`) fail(`summary ${create[0].summary}`);
if ((preview.plan ?? []).some((p) => JSON.stringify(p).includes(HISTORICAL_WP_ID) && p.action !== "IGNORED")) {
  fail("historical WP entered write plan");
}
if (!(preview.outOfScopeWorkPackages ?? []).some((w) => w.id === HISTORICAL_WP_ID)) {
  fail("historical WP missing from outOfScopeWorkPackages");
}
if (sha(join(repo, "wp", WP_ID, "index.md")) !== beforeHashes.current) fail("preview rewrote current WP index");
if (sha(join(repo, "wp", HISTORICAL_WP_ID, "index.md")) !== beforeHashes.historical) {
  fail("preview rewrote historical WP index");
}

const siblingId = "WP-20260915-001";
mkdirSync(join(repo, "design", siblingId), { recursive: true });
writeFileSync(join(repo, "design", siblingId, "index.md"), "sibling body\n");
writeFileSync(
  join(repo, "design", siblingId, "change-spec.json"),
  `${JSON.stringify({ id: siblingId, design: { title: "Sibling ready WP" } }, null, 2)}\n`,
);
mkdirSync(join(repo, "wp", siblingId), { recursive: true });
writeFileSync(
  join(repo, "wp", siblingId, "index.md"),
  "---\nid: WP-20260915-001\ntype: wp\nrole: developer\nstatus: ready\n---\n",
);
mkdirSync(join(repo, "work-packages", siblingId), { recursive: true });
writeFileSync(
  join(repo, "work-packages", siblingId, "manifest.json"),
  `${JSON.stringify({ id: siblingId, status: "ready", jiraIssueKey: "PLANNED" }, null, 2)}\n`,
);

const scoped = await architectPreviewOp({
  repo,
  epic: seeded.epicKey,
  provider: seeded.provider,
  wp: WP_ID,
});
const scopedCreate = (scoped.plan ?? []).filter((p) => p.action === "CREATE" && p.kind === "work-package");
if (scopedCreate.length !== 1 || scopedCreate[0].localWorkPackageId !== WP_ID) {
  fail(`explicit scope leaked sibling: ${JSON.stringify(scopedCreate)}`);
}

try {
  await architectPreviewOp({
    repo,
    epic: seeded.epicKey,
    provider: seeded.provider,
  });
  fail("omitted workPackageId with multiple ready WPs should be WORK_PACKAGE_SCOPE_AMBIGUOUS");
} catch (e) {
  if (!(e instanceof PraxisOpError) || e.code !== "WORK_PACKAGE_SCOPE_AMBIGUOUS") {
    fail(`expected WORK_PACKAGE_SCOPE_AMBIGUOUS, got ${e instanceof Error ? e.message : e}`);
  }
}

const applied = await architectApplyOp({
  repo,
  epic: seeded.epicKey,
  provider: seeded.provider,
  wp: WP_ID,
  confirmation: "YES",
  previewFingerprint: scoped.previewFingerprint,
});
if (applied.workPackages?.length !== 1) fail(`apply created ${JSON.stringify(applied.workPackages)}`);
if (applied.workPackages[0].id !== WP_ID) fail("apply materialized wrong WP");
if (applied.readyForDevelopment !== true) fail("successful apply should set readyForDevelopment=true");
const wpKey = applied.workPackages[0].jiraIssueKey;
const summaries = [...state.issues.values()].map((i) => i.summary);
if (!summaries.some((s) => s.includes(WP_ID) && s.includes(LIVE_WP_TITLE))) {
  fail(`mock Jira missing canonical WP summary: ${JSON.stringify(summaries)}`);
}
if (summaries.some((s) => s.includes(HISTORICAL_WP_ID))) fail("historical WP materialized in mock Jira");
if (resolveRemoteWpKey(repo, WP_ID) !== wpKey) fail("Developer resolution missed canonical WP");

const rerunPreview = await architectPreviewOp({
  repo,
  epic: seeded.epicKey,
  provider: seeded.provider,
  wp: WP_ID,
});
const rerunCreate = (rerunPreview.plan ?? []).filter((p) => p.action === "CREATE" && p.kind === "work-package");
if (rerunCreate.length !== 0) fail(`rerun preview CREATE not empty: ${JSON.stringify(rerunCreate)}`);
const rerun = await architectApplyOp({
  repo,
  epic: seeded.epicKey,
  provider: seeded.provider,
  wp: WP_ID,
  confirmation: "YES",
  previewFingerprint: rerunPreview.previewFingerprint,
});
if (rerun.workPackages[0].jiraIssueKey !== wpKey) fail("rerun apply not idempotent");

console.log(
  JSON.stringify(
    {
      ok: true,
      version,
      workPackageId: WP_ID,
      create: 1,
      title: LIVE_WP_TITLE,
      jiraWorkPackageKey: wpKey,
      historicalExcluded: HISTORICAL_WP_ID,
      readyForDevelopmentPreview: false,
      readyForDevelopmentApply: true,
      previewFingerprint: scoped.previewFingerprint,
    },
    null,
    2,
  ),
);
