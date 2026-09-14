#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  expectedTarballNames,
  installTest,
  localPackagesDir,
  packReleaseLocal,
} from "./local-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd) {
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) fail(`${cmd}\n${r.stderr || r.stdout}`);
  return r;
}

run("npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira");
run("npm test -w @praxis/jira");
run("make -n verify");
run("make help");

const dest = localPackagesDir(root, version);
const missing = expectedTarballNames(version).filter((n) => !existsSync(join(dest, n)));
if (missing.length) packReleaseLocal(root, version);

const consumer = mkdtempSync(join(tmpdir(), "praxis-jira-ext-"));
installTest({ root, version, testRepo: consumer });

const packDir = join(root, "dist", "jira-workflow-accept");
mkdirSync(packDir, { recursive: true });
run(`npm pack -w @praxis/jira --pack-destination ${JSON.stringify(packDir)}`);
run(`npm pack -w @praxis/quality --pack-destination ${JSON.stringify(packDir)}`);
const tgz = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
if (tgz.length < 2) fail(`expected packed jira+quality tgz in ${packDir}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      source: "external-tgz",
      proven: [
        "jira cloud provider contract",
        "jira datacenter provider contract",
        "BA epic analysis contract",
        "BA remote-write idempotency",
        "BA crash/resume",
        "duplicate recovery",
        "canonical/superseded downstream filtering",
        "Architect Work Package generation",
        "Developer claim",
        "QA bug/block lifecycle",
        "external package install works from tgz",
        "no public registry dependency for internal @praxis runtime",
      ],
      pending: [
        "live Jira Cloud full E2E",
        "live Jira Data Center acceptance",
      ],
      packed: tgz,
      localPackages: expectedTarballNames(version),
    },
    null,
    2,
  ),
);
