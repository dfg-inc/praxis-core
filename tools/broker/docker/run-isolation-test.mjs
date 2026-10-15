#!/usr/bin/env node
/**
 * Two-UID Docker isolation test using named volumes (bind mounts on Docker
 * Desktop for macOS do not enforce Linux file ownership).
 *
 * Agent = uid 1000. Broker/executor = uid 1001.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const contracts = require(join(root, "packages/contracts/dist/index.js"));
const image = process.env.PRAXIS_ISOLATION_IMAGE || "node:20-bookworm-slim";
const suffix = randomUUID().slice(0, 8);
const trustedVol = `praxis-iso-trusted-${suffix}`;
const sharedVol = `praxis-iso-shared-${suffix}`;
const seed = mkdtempSync(join(tmpdir(), "praxis-iso-seed-"));

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function must(result, label) {
  if ((result.status ?? 1) !== 0) {
    console.error(label, result.stderr || result.stdout);
    cleanup();
    process.exit(1);
  }
}

function cleanup() {
  run("docker", ["volume", "rm", "-f", trustedVol, sharedVol]);
  rmSync(seed, { recursive: true, force: true });
}

const keys = contracts.generateApprovalKeyPair();
writeFileSync(join(seed, "private.pem"), keys.privateKeyPem);
writeFileSync(join(seed, "public.pem"), keys.publicKeyPem);
writeFileSync(
  join(seed, "credentials.json"),
  `${JSON.stringify({ jiraToken: "trusted-jira-token-not-for-agent", gitToken: "trusted-git-token-not-for-agent" }, null, 2)}\n`,
);
writeFileSync(join(seed, ".broker-identity"), "broker\n");

const now = new Date();
const plan = contracts.buildActionPlan({
  planId: "plan-demo",
  role: "developer",
  decisionKind: "git_operation",
  summary: "Connect origin remote for WP-1",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: ["WP-1"],
  storyIds: [],
  decisionIds: [],
  repositories: ["/workspace"],
  actions: [{ action: "praxis_developer_git_connect_apply", description: "add origin", targets: ["origin"] }],
  risks: ["remote mutation"],
  sideEffects: ["git remote add"],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
});
writeFileSync(join(seed, "plan-demo.json"), `${JSON.stringify(plan, null, 2)}\n`);
writeFileSync(
  join(seed, "payload.json"),
  `${JSON.stringify({
    planFingerprint: plan.fingerprint,
    provider: plan.provider,
    instanceId: plan.instanceId,
    operation: plan.operations[0],
    workItemId: plan.workItemIds[0],
    repository: plan.repositories[0],
  })}\n`,
);
writeFileSync(
  join(seed, "payload-bad.json"),
  `${JSON.stringify({
    planFingerprint: plan.fingerprint,
    provider: "jira",
    instanceId: plan.instanceId,
    operation: plan.operations[0],
    workItemId: plan.workItemIds[0],
    repository: plan.repositories[0],
  })}\n`,
);

must(run("docker", ["volume", "create", trustedVol]), "create trusted volume");
must(run("docker", ["volume", "create", sharedVol]), "create shared volume");

must(
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${seed}:/seed:ro`,
    "-v",
    `${trustedVol}:/trusted`,
    "-v",
    `${sharedVol}:/shared`,
    image,
    "bash",
    "-lc",
    [
      "mkdir -p /trusted/ledger /trusted/audit /shared/pending /shared/authorizations",
      "cp /seed/private.pem /seed/public.pem /seed/credentials.json /seed/.broker-identity /trusted/",
      "cp /seed/plan-demo.json /shared/pending/",
      "cp /seed/payload.json /seed/payload-bad.json /shared/",
      "chown -R 1001:1001 /trusted",
      "chmod 700 /trusted",
      "chmod 600 /trusted/private.pem /trusted/credentials.json",
      "chown -R 1001:1001 /shared",
      "chmod 755 /shared /shared/pending /shared/authorizations",
      "chmod 644 /shared/pending/plan-demo.json /shared/payload.json /shared/payload-bad.json",
    ].join(" && "),
  ]),
  "seed volumes",
);

function docker(user, env, command) {
  return run("docker", [
    "run",
    "--rm",
    "--user",
    user,
    "-v",
    `${root}:/workspace:ro`,
    "-v",
    `${sharedVol}:/shared`,
    "-v",
    `${trustedVol}:/trusted`,
    "-e",
    "PRAXIS_BROKER_SHARED_DIR=/shared",
    "-e",
    "PRAXIS_BROKER_TRUSTED_DIR=/trusted",
    "-e",
    "PRAXIS_CONTRACTS_ENTRY=/workspace/packages/contracts/dist/index.js",
    ...env.flatMap((item) => ["-e", item]),
    image,
    "bash",
    "-lc",
    command,
  ]);
}

const broker = "node /workspace/tools/broker/praxis-broker.mjs";
const executor = "node /workspace/tools/broker/praxis-executor.mjs";
const brokerEnv = [
  "PRAXIS_APPROVAL_PRIVATE_KEY_PATH=/trusted/private.pem",
  "PRAXIS_APPROVAL_PUBLIC_KEY_PATH=/trusted/public.pem",
  "PRAXIS_APPROVAL_LEDGER=/trusted/ledger",
  "PRAXIS_BROKER_MACHINE_APPROVE=1",
];
const executorEnv = [
  "PRAXIS_APPROVAL_PUBLIC_KEY_PATH=/trusted/public.pem",
  "PRAXIS_APPROVAL_LEDGER=/trusted/ledger",
];

const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

check("agent_cannot_read_private_key", (docker("1000:1000", [], "cat /trusted/private.pem").status ?? 1) !== 0);
check("agent_cannot_write_ledger", (docker("1000:1000", [], "echo forged > /trusted/ledger/x.json").status ?? 1) !== 0);
check("agent_cannot_read_credentials", (docker("1000:1000", [], "cat /trusted/credentials.json").status ?? 1) !== 0);
check(
  "agent_cannot_approve",
  (docker("1000:1000", brokerEnv, `${broker} approve --plan-id plan-demo --approver agent`).status ?? 1) !== 0,
);

const shown = docker("1001:1001", brokerEnv, `${broker} show --plan-id plan-demo`);
check("broker_shows_exact_plan", (shown.status ?? 1) === 0 && shown.stdout.includes("Connect origin remote"));

const approved = docker("1001:1001", brokerEnv, `${broker} approve --plan-id plan-demo --approver operator`);
check("broker_signs_authorization", (approved.status ?? 1) === 0 && approved.stdout.includes('"ok":true'));

// forge token as root helper then re-chown shared authorizations for executor
must(
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${sharedVol}:/shared`,
    image,
    "bash",
    "-lc",
    "echo forged > /shared/authorizations/forged.token && chown -R 1001:1001 /shared && chmod 755 /shared/authorizations && chmod 644 /shared/authorizations/* /shared/payload.json /shared/payload-bad.json /shared/pending/plan-demo.json",
  ]),
  "forge token",
);

check(
  "forged_token_rejected",
  (docker("1001:1001", executorEnv, `${executor} execute --token /shared/authorizations/forged.token --action praxis_developer_git_connect_apply`).status ?? 1) !== 0,
);

const first = docker(
  "1001:1001",
  executorEnv,
  `${executor} execute --token /shared/authorizations/plan-demo.token --action praxis_developer_git_connect_apply --payload /shared/payload.json`,
);
check("approved_operation_once", (first.status ?? 1) === 0 && first.stdout.includes('"replayed":false'));

const second = docker(
  "1001:1001",
  executorEnv,
  `${executor} execute --token /shared/authorizations/plan-demo.token --action praxis_developer_git_connect_apply --payload /shared/payload.json`,
);
check("duplicate_replay", (second.status ?? 1) === 0 && second.stdout.includes('"replayed":true'));

check(
  "changed_provider_rejected",
  (docker("1001:1001", executorEnv, `${executor} execute --token /shared/authorizations/plan-demo.token --action praxis_developer_git_connect_apply --payload /shared/payload-bad.json`).status ?? 1) !== 0,
);

check("agent_cannot_run_executor", (docker("1000:1000", executorEnv, `${executor} health`).status ?? 1) !== 0);

const failed = results.filter((item) => !item.ok);
console.log(`volumes ${trustedVol} ${sharedVol}`);
cleanup();
console.log(failed.length ? "ISOLATION_TEST FAIL" : "ISOLATION_TEST PASS");
process.exit(failed.length ? 1 : 0);
