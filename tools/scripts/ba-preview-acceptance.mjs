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

const { baPreviewOp } = await import("@praxis/cli/operations");
const { createCanonicalMock, seedCanonicalJira, writeCanonicalRepo } = await import("./preview-fixture.mjs");

const { fetchImpl } = createCanonicalMock();
const seeded = await seedCanonicalJira(fetchImpl);
const repo = mkdtempSync(join(tmpdir(), "praxis-accept-ba-preview-"));
writeCanonicalRepo(repo);

const started = Date.now();
const result = await baPreviewOp({
  repo,
  epic: seeded.epicKey,
  provider: seeded.provider,
});
const durationMs = Date.now() - started;
if (durationMs > 15_000) fail(`BA preview exceeded 15s: ${durationMs}ms`);
if (!result.ok) fail(`BA preview not ok: ${JSON.stringify(result)}`);
if (result.handoff.readyForArchitecture !== true) fail("readyForArchitecture != true");
if (JSON.stringify(result.handoff.canonicalStoryKeys) !== JSON.stringify([seeded.canonKey])) {
  fail(`canonical ${JSON.stringify(result.handoff.canonicalStoryKeys)}`);
}
const create = result.plan.filter((p) => p.action === "CREATE");
const update = result.plan.filter((p) => p.action === "UPDATE");
if (create.length) fail(`unexpected CREATE ${JSON.stringify(create)}`);
if (update.length) fail(`unexpected UPDATE ${JSON.stringify(update)}`);
const superseded = (result.handoff.supersededStoryKeys ?? []).map((from) => ({
  from,
  to: seeded.canonKey,
}));
if (!superseded.some((s) => s.from === seeded.dupKey && s.to === seeded.canonKey)) {
  fail(`missing superseded ${seeded.dupKey} -> ${seeded.canonKey}`);
}

const out = {
  ok: true,
  version,
  epic: seeded.epicKey,
  canonicalStories: result.handoff.canonicalStoryKeys,
  superseded,
  create: [],
  update: [],
  readyForArchitecture: true,
  durationMs: result.durationMs ?? durationMs,
  stages: result.stages,
  previewFingerprint: result.previewFingerprint,
};
console.log(JSON.stringify(out, null, 2));
