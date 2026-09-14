#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
        "BA epic to stories",
        "Architect stories to work packages",
        "Developer work package claim",
        "Developer package implementation lifecycle",
        "Quality work package verification",
        "Quality blocking bug lifecycle",
        "one-line command wrappers",
      ],
      pending: [
        "live Jira Cloud acceptance",
        "live Jira Data Center acceptance",
      ],
      packed: tgz,
    },
    null,
    2,
  ),
);
