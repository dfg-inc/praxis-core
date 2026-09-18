#!/usr/bin/env node
import { mkdtempSync, readFileSync } from "node:fs";
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

const { architectPreviewOp, previewFingerprint } = await import("@praxis/cli/operations");
const { createCanonicalMock, seedCanonicalJira, writeCanonicalRepo, WP_ID, HISTORICAL_WP_ID, LIVE_WP_TITLE } = await import("./preview-fixture.mjs");

const { fetchImpl } = createCanonicalMock();
const seeded = await seedCanonicalJira(fetchImpl);
const repo = mkdtempSync(join(tmpdir(), "praxis-accept-arch-preview-"));
writeCanonicalRepo(repo);

function hashWpIndexes() {
  return {
    current: readFileSync(join(repo, "wp", WP_ID, "index.md"), "utf8"),
    historical: readFileSync(join(repo, "wp", HISTORICAL_WP_ID, "index.md"), "utf8"),
  };
}
const before = hashWpIndexes();

const started = Date.now();
const result = await architectPreviewOp({
  repo,
  epic: seeded.epicKey,
  provider: seeded.provider,
  wp: WP_ID,
});
const durationMs = Date.now() - started;
if (durationMs > 15_000) fail(`Architect preview exceeded 15s: ${durationMs}ms`);
if (!result.ok) fail(`Architect preview not ok: ${JSON.stringify(result)}`);
if (result.readyForDevelopment !== false) fail("preview readyForDevelopment must stay false until apply");
const after = hashWpIndexes();
if (after.current !== before.current || after.historical !== before.historical) {
  fail("preview rewrote wp/*/index.md");
}
const plan = result.plan ?? [];
const create = plan.filter((p) => p.action === "CREATE" && p.kind === "work-package");
const link = plan.filter((p) => p.action === "LINK");
const ignored = plan.filter((p) => p.action === "IGNORED");
if (create.length !== 1) fail(`expected 1 WP CREATE, got ${JSON.stringify(create)}`);
if (create[0].localWorkPackageId !== WP_ID) fail(`created wrong WP: ${JSON.stringify(create)}`);
if (create[0].summary !== `[${WP_ID}] ${LIVE_WP_TITLE}`) fail(`bad summary: ${create[0].summary}`);
if (create[0].summary.includes("---")) fail("title resolved to ---");
if (result.workPackage?.title !== LIVE_WP_TITLE) fail(`title ${result.workPackage?.title}`);
if (result.workPackage?.titleSource !== "design.change-spec") fail(`titleSource ${result.workPackage?.titleSource}`);
if (link.length !== 1) fail(`expected 1 LINK, got ${JSON.stringify(link)}`);
if (!ignored.some((p) => p.jiraIssueKey === seeded.dupKey)) fail("PRX-2 not ignored");
if ((result.outOfScopeWorkPackages ?? []).some((w) => w.id === WP_ID)) fail("canonical WP marked out of scope");
if (!(result.outOfScopeWorkPackages ?? []).some((w) => w.id === HISTORICAL_WP_ID)) {
  fail("historical WP not reported out of scope");
}
if (JSON.stringify(result).match(/wp:PRX-/)) fail("wp:PRX-3 identity leaked");
if (JSON.stringify(result).match(/Technical implementation for/)) fail("generic tech task");
if (JSON.stringify(result).match(/flowchart LR\s*A-->B/)) fail("placeholder mermaid");
if (JSON.stringify(create).includes(HISTORICAL_WP_ID)) fail("historical WP leaked into CREATE");
const fp2 = await architectPreviewOp({
  repo,
  epic: seeded.epicKey,
  provider: seeded.provider,
  wp: WP_ID,
});
if (fp2.previewFingerprint !== result.previewFingerprint) fail("fingerprint not deterministic");
if (result.previewFingerprint !== previewFingerprint(result.plan)) fail("fingerprint mismatch vs plan");

const out = {
  ok: true,
  version,
  epic: seeded.epicKey,
  canonicalStory: seeded.canonKey,
  superseded: [seeded.dupKey],
  workPackageId: "WP-20260914-002",
  plan: {
    create: create.length,
    link: link.length,
    update: plan.filter((p) => p.action === "UPDATE").length,
  },
    durationMs: result.durationMs ?? durationMs,
  stages: result.stages,
  previewFingerprint: result.previewFingerprint,
  workPackage: result.workPackage,
  outOfScopeWorkPackages: result.outOfScopeWorkPackages,
  readyForDevelopment: result.readyForDevelopment,
};
console.log(JSON.stringify(out, null, 2));
