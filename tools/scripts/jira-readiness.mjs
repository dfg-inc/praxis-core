#!/usr/bin/env node
/**
 * Deterministic Jira readiness (WBS 3.x) — no live mutations.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const tests = spawnSync("npm", ["test", "-w", "@praxis/jira"], {
  cwd: root,
  encoding: "utf8",
});
if ((tests.status ?? 1) !== 0) fail(`jira tests:\n${tests.stderr || tests.stdout}`);

const liveEnv = Boolean(
  process.env.PRAXIS_JIRA_BASE_URL &&
    process.env.PRAXIS_JIRA_TOKEN &&
    process.env.PRAXIS_JIRA_PROJECT_KEY,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      source: "jira-readiness-deterministic",
      proven: [
        "3.1 config validation + PAT version gate",
        "3.2–3.8 preview/confirm packages (no write on reject)",
        "3.3.2 8h story ceiling",
        "3.9 read-only status client",
      ],
      pending: [
        "live Jira Cloud full E2E",
        "live Jira Data Center acceptance",
      ],
      liveEnvPresent: liveEnv,
      mutations: "not attempted",
    },
    null,
    2,
  ),
);
