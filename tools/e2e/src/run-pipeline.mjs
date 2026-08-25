#!/usr/bin/env node
/**
 * Deterministic BA → Architect → Developer → Quality pipeline.
 * Copies fixtures to a work dir, runs real local tools (no mocks).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureSrc = join(root, "tools/e2e/fixtures/pipeline");
const wpId = "WP-20260825-001";

function run(label, cmd, cwd, env = {}) {
  console.log(`\n=== ${label} ===\n$ ${cmd}`);
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    throw new Error(`${label} failed with exit ${r.status}`);
  }
  return r;
}

function parseLastJson(text) {
  const matches = [...text.matchAll(/\{[\s\S]*?\}(?=\s*$|\s*\{)/g)];
  // Prefer last JSON object with "ok" or "contract"
  const chunks = text.split(/\n(?=\{)/);
  for (let i = chunks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(chunks[i]);
    } catch {
      /* continue */
    }
  }
  void matches;
  throw new Error("no JSON output found");
}

export function runPipeline(opts = {}) {
  const keep = opts.keep === true;
  const work = opts.workDir
    ? opts.workDir
    : mkdtempSync(join(tmpdir(), "praxis-e2e-"));
  if (existsSync(join(work, "canon"))) {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
  }
  mkdirSync(work, { recursive: true });
  cpSync(fixtureSrc, work, { recursive: true });

  const canon = join(work, "canon");
  const product = join(work, "product");
  const design = join(work, "design");
  const dbPath = join(work, "quality.sqlite");

  // Prove product is initially failing tests (determinism of the bug)
  const pre = spawnSync("npm run test", {
    cwd: product,
    shell: true,
    encoding: "utf8",
  });
  if (pre.status === 0) {
    throw new Error("fixture product should fail tests before Developer run");
  }

  // BA: validate canon (executable engine, not mock)
  const baBin = join(root, "plugins/ba/canon-graph/bin/praxis-ba.mjs");
  run(
    "BA validate",
    `${process.execPath} ${baBin} validate --repo ${canon}`,
    work,
  );

  // BA → Architect handoff
  const emit = join(root, "plugins/ba/tools/emit-architect-handoff.mjs");
  const baOut = run(
    "BA emit architect handoff",
    `${process.execPath} ${emit} --repo ${canon} --wp ${wpId}`,
    work,
  );
  const baJson = parseLastJson(baOut.stdout);
  const baHandoffPath = baJson.path;

  // Architect package
  const archTool = join(
    root,
    "plugins/architect/tools/build-architecture-package.mjs",
  );
  const changeSpecSrc = join(work, "change-spec.json");
  const archOut = run(
    "Architect build package",
    `${process.execPath} ${archTool} --ba-handoff ${baHandoffPath} --canon ${canon} --out ${design} --product ${product} --change-spec ${changeSpecSrc}`,
    work,
  );
  const archJson = parseLastJson(archOut.stdout);
  const archHandoffPath = archJson.handoffPath;
  const designDir = archJson.designDir;

  // Developer executable flow
  const devTool = join(root, "plugins/developer/tools/run-work-package.mjs");
  const devOut = run(
    "Developer run work package",
    `${process.execPath} ${devTool} --arch-handoff ${archHandoffPath} --design-dir ${designDir} --product ${product} --approve`,
    work,
  );
  const devJson = parseLastJson(devOut.stdout);
  const qualityHandoffPath = devJson.qualityHandoffPath;

  // Quality review + persist
  const qualityBin = join(root, "apps/quality-service/bin/praxis-quality.mjs");
  const qOut = run(
    "Quality review-path",
    `${process.execPath} ${qualityBin} review-path --path ${product} --handoff ${qualityHandoffPath} --project e2e-pipeline`,
    work,
    { PRAXIS_QUALITY_DB: dbPath },
  );
  const qJson = parseLastJson(qOut.stdout);

  const report = run(
    "Quality report",
    `${process.execPath} ${qualityBin} report --project e2e-pipeline`,
    work,
    { PRAXIS_QUALITY_DB: dbPath },
  );
  const reportJson = parseLastJson(report.stdout);

  const summary = {
    ok: true,
    work,
    baHandoffPath,
    archHandoffPath,
    qualityHandoffPath,
    qualityVerdict: qJson.verdict,
    reviewsPersisted: reportJson.reviews?.length ?? 0,
    greeter: readFileSync(join(product, "src/greeter.js"), "utf8"),
  };
  writeFileSync(join(work, "pipeline-summary.json"), JSON.stringify(summary, null, 2));

  if (!keep && !opts.workDir) {
    // keep for debugging on failure only; success cleans unless keep
  }

  return summary;
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    const summary = runPipeline({ keep: process.argv.includes("--keep") });
    console.log("\nPIPELINE OK\n", JSON.stringify(summary, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
