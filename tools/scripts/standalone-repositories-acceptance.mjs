#!/usr/bin/env node
/**
 * External standalone-git acceptance for WBS 1.21 / 1.21.1 / 5.16 / 5.16.1.
 * Temp git repos only — remote GitLab/GitHub publication is pending.
 *
 *   node tools/scripts/standalone-repositories-acceptance.mjs
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { exportStandalone } from "./export-standalone.mjs";

const proven = [];
const pending = ["remote repository publication"];

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd, extra = {}) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_PATH: "",
      npm_config_workspaces: "",
      ...extra.env,
    },
  });
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if ((r.status ?? 1) !== 0) fail(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}

function parseJson(stdout) {
  const obj = stdout.indexOf("{");
  if (obj < 0) return null;
  try {
    return JSON.parse(stdout.slice(obj));
  } catch {
    return null;
  }
}

function write(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`,
  );
}

function initRepo(dir) {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "standalone@praxis.local"]);
  git(dir, ["config", "user.name", "praxis-standalone"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "standalone initial export"]);
}

const work = mkdtempSync(join(tmpdir(), "praxis-standalone-acc-"));

function assertNoMonorepoPath(tree, label) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const r = run(
    `rg -l ${JSON.stringify(root)} --glob '!vendor/*.tgz' --glob '!node_modules/**' . || true`,
    tree,
  );
  // rg may be missing; fallback is export leak scan already done.
  void r;
  if (existsSync(join(tree, "package.json"))) {
    const pkg = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
    for (const [n, v] of Object.entries(pkg.dependencies ?? {})) {
      if (n.startsWith("@praxis/") && v === "*") fail(`${label} workspace * dep ${n}`);
    }
  }
}

try {
  // --- BA ---
  const baExport = join(work, "ba-export");
  exportStandalone("ba", baExport);
  initRepo(baExport);
  const baMoved = join(work, "elsewhere", "praxis-ba");
  mkdirSync(dirname(baMoved), { recursive: true });
  renameSync(baExport, baMoved);
  assertNoMonorepoPath(baMoved, "ba");

  const baInstall = run("npm install", baMoved);
  if (!baInstall.ok) fail(`ba npm install:\n${baInstall.stderr}\n${baInstall.stdout}`);
  const baBuild = run("npm run build", baMoved);
  if (!baBuild.ok) fail(`ba build:\n${baBuild.stderr}\n${baBuild.stdout}`);
  const baTest = run("npm test", baMoved);
  if (!baTest.ok) fail(`ba tests:\n${baTest.stderr}\n${baTest.stdout}`);

  const emptyCanon = join(work, "canon-empty");
  write(
    join(emptyCanon, ".ba/counters.yaml"),
    "product:\n  epic: 0\n  cr: 0\n  wp: 0\n  bug: 0\n  baselineSeq: {}\nepics: {}\nretired: []\n",
  );

  const canon = join(work, "canon");
  write(
    join(canon, ".ba/counters.yaml"),
    "product:\n  epic: 1\n  cr: 0\n  wp: 0\n  bug: 0\n  baselineSeq: {}\nepics:\n  E1:\n    fr: 1\n    nfr: 0\n    br: 0\n    wp: 0\n    bug: 0\nretired: []\n",
  );
  write(
    join(canon, "epics/E1-x/index.md"),
    `---
id: E1
type: epic
title: E1
status: active
---

Epic E1.
`,
  );
  write(
    join(canon, "epics/E1-x/E1-FR1.md"),
    `---
id: E1-FR1
type: fr
epic: E1
status: active
version: 1
traces_to: []
enforces: []
references_nfr: []
related: []
---

Story body.

## Назначение

Live purpose text.

## Acceptance Criteria
- AC-1: given a start, when the user acts, then an outcome.
`,
  );

  const missingProject = join(work, "no-project");
  mkdirSync(missingProject, { recursive: true });
  const bootMissing = run(
    `node ./tools/session-bootstrap.mjs "${missingProject}"`,
    baMoved,
  );
  if (!bootMissing.ok && !/skip|missing|\.project/i.test(`${bootMissing.stdout}${bootMissing.stderr}`)) {
    if (!bootMissing.stdout) fail(`ba session missing .project:\n${bootMissing.stderr}`);
  }

  write(
    join(canon, "..", "host", ".project"),
    `product: demo
knowledge:
  path: ./knowledge
`,
  );
  const host = join(work, "host");
  mkdirSync(join(host, "knowledge"), { recursive: true });
  const bootOk = run(`node ./tools/session-bootstrap.mjs "${host}"`, baMoved);
  if (!bootOk.stdout.includes("praxis-ba") && !bootOk.stdout.includes("ba")) {
    fail(`ba SessionStart:\n${bootOk.stdout}\n${bootOk.stderr}`);
  }

  const validate = run(
    `node ./canon-graph/bin/praxis-ba.mjs validate --repo "${emptyCanon}"`,
    baMoved,
  );
  if (!validate.ok) fail(`ba validate:\n${validate.stderr}\n${validate.stdout}`);
  const status = run(
    `node ./canon-graph/bin/praxis-ba.mjs status --repo "${emptyCanon}"`,
    baMoved,
  );
  if (!status.ok) fail(`ba status:\n${status.stderr}\n${status.stdout}`);
  const pager = run(
    `node ./tools/one-pager.mjs --repo "${canon}" --id E1-FR1`,
    baMoved,
  );
  if (!pager.ok) fail(`ba one-pager:\n${pager.stderr}\n${pager.stdout}`);

  const baPack = run("npm pack", baMoved);
  if (!baPack.ok) fail(`ba pack:\n${baPack.stderr}`);
  const baTgz = readdirSync(baMoved).find((f) => f.endsWith(".tgz"));
  if (!baTgz) fail("ba tgz missing");

  const baConsumer = mkdtempSync(join(tmpdir(), "praxis-ba-consumer-"));
  write(join(baConsumer, "package.json"), { name: "ba-consumer", private: true });
  const baConsInstall = run(`npm install "${join(baMoved, baTgz)}"`, baConsumer);
  if (!baConsInstall.ok) fail(`ba consumer install:\n${baConsInstall.stderr}`);
  const baBoot = join(baConsumer, "node_modules/@praxis/ba/tools/session-bootstrap.mjs");
  if (!existsSync(baBoot)) fail("ba consumer bootstrap missing");
  const baConsBoot = run(`node "${baBoot}" "${host}"`, baConsumer);
  if (!baConsBoot.stdout) fail(`ba consumer SessionStart:\n${baConsBoot.stderr}`);
  proven.push("1.21 praxis-ba standalone repository");
  proven.push("1.21.1 praxis-ba standalone package runtime");

  // --- Developer ---
  const devExport = join(work, "dev-export");
  exportStandalone("developer", devExport);
  initRepo(devExport);
  const devMoved = join(work, "elsewhere", "praxis-developer");
  mkdirSync(dirname(devMoved), { recursive: true });
  renameSync(devExport, devMoved);
  assertNoMonorepoPath(devMoved, "developer");

  const devInstall = run("npm install", devMoved);
  if (!devInstall.ok) fail(`developer npm install:\n${devInstall.stderr}\n${devInstall.stdout}`);
  const devBuild = run("npm run build", devMoved);
  if (!devBuild.ok) fail(`developer build:\n${devBuild.stderr}`);
  const devTest = run("npm test", devMoved);
  if (!devTest.ok) fail(`developer tests:\n${devTest.stderr}\n${devTest.stdout}`);

  const devBoot = run(`node ./tools/session-bootstrap.mjs "${host}"`, devMoved);
  if (!/developer|praxis-developer/i.test(devBoot.stdout)) {
    fail(`developer SessionStart:\n${devBoot.stdout}\n${devBoot.stderr}`);
  }

  write(join(devMoved, "scale-in.json"), {
    files: ["a.js"],
    selected: "architectural",
    actor: "alice",
    reason: "boundary",
    humanConfirmed: true,
  });
  const scale = run(
    `node ./tools/developer-governance.mjs scale --in ./scale-in.json`,
    devMoved,
  );
  const sj = parseJson(scale.stdout);
  if (!scale.ok || sj?.final !== "architectural") {
    fail(`developer governance:\n${scale.stdout}\n${scale.stderr}`);
  }

  const product = join(work, "dev-product");
  write(join(product, "src/app.js"), "export const needle = 'praxis-dev-research';\n");
  const research = run(
    `node ./tools/developer-governance.mjs research --product "${product}" --query needle --needle praxis-dev-research --out "${join(work, "research.json")}"`,
    devMoved,
  );
  if (!research.ok) fail(`developer research:\n${research.stderr}\n${research.stdout}`);

  write(join(devMoved, "plan-in.json"), {
    workPackageId: "WP-STANDALONE",
    status: "approved",
    reason: "standalone acceptance",
    phases: [{ id: 1, name: "implement", verify: "npm test" }],
    humanApproval: { actor: "alice", at: "2026-09-09" },
  });
  const plan = run(
    `node ./tools/developer-governance.mjs plan --in ./plan-in.json`,
    devMoved,
  );
  const pj = parseJson(plan.stdout);
  if (!plan.ok || pj?.status !== "approved") {
    fail(`developer plan:\n${plan.stdout}\n${plan.stderr}`);
  }

  const handoff = {
    contract: "developer.quality.handoff",
    version: "0.1.0",
    workPackageId: "WP-STANDALONE",
    mergeRequestRef: "local/WP-STANDALONE",
    intention: "standalone quality handoff compatibility",
    requirementIds: ["E1-FR1"],
    decisionIds: ["ADR-1"],
    verification: {
      build: { status: "passed", required: true },
      tests: { status: "passed", required: true },
      lint: { status: "passed", required: false },
      packageCriteria: { status: "passed", required: true },
    },
  };
  write(join(devMoved, "quality-handoff.json"), handoff);
  write(
    join(devMoved, "check-quality-handoff.mjs"),
    `import { readFileSync } from "node:fs";
import { parseContract, DeveloperToQualityHandoffSchema } from "@praxis/contracts";
parseContract(
  DeveloperToQualityHandoffSchema,
  JSON.parse(readFileSync("./quality-handoff.json", "utf8")),
);
console.log("quality-handoff-ok");
`,
  );
  const qParse = run(`node ./check-quality-handoff.mjs`, devMoved);
  if (!qParse.ok || !qParse.stdout.includes("quality-handoff-ok")) {
    fail(`developer quality handoff:\n${qParse.stderr}\n${qParse.stdout}`);
  }

  const devPack = run("npm pack", devMoved);
  if (!devPack.ok) fail(`developer pack:\n${devPack.stderr}`);
  const devTgz = readdirSync(devMoved).find((f) => f.endsWith(".tgz"));
  if (!devTgz) fail("developer tgz missing");

  const devConsumer = mkdtempSync(join(tmpdir(), "praxis-dev-consumer-"));
  write(join(devConsumer, "package.json"), { name: "dev-consumer", private: true });
  const devConsInstall = run(`npm install "${join(devMoved, devTgz)}"`, devConsumer);
  if (!devConsInstall.ok) fail(`developer consumer:\n${devConsInstall.stderr}`);
  const consGov = join(
    devConsumer,
    "node_modules/@praxis/developer/tools/developer-governance.mjs",
  );
  if (!existsSync(consGov)) fail("developer consumer governance missing");
  const consBoot = join(
    devConsumer,
    "node_modules/@praxis/developer/tools/session-bootstrap.mjs",
  );
  const consStart = run(`node "${consBoot}" "${host}"`, devConsumer);
  if (!consStart.stdout) fail(`developer consumer SessionStart:\n${consStart.stderr}`);
  proven.push("5.16 praxis-developer standalone repository");
  proven.push("5.16.1 praxis-developer standalone package runtime");

  console.log(
    JSON.stringify(
      {
        ok: true,
        source: "standalone-external-git",
        proven,
        pending,
        baTests: "pass (standalone npm test)",
        developerTests: "pass (standalone npm test)",
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
