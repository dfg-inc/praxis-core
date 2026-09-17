#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packClaudePlugins } from "./pack-claude-plugins.mjs";
import { verifyClaudePlugins } from "./verify-claude-plugins.mjs";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const check = spawnSync("node tools/scripts/check-skill-cli.mjs", {
  cwd: root,
  shell: true,
  encoding: "utf8",
});
if ((check.status ?? 1) !== 0) fail(check.stderr || check.stdout);

packClaudePlugins(version);
const report = verifyClaudePlugins(version);
if (!report.ok) fail("verify-claude-plugins failed");
console.log(JSON.stringify(report, null, 2));
