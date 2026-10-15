#!/usr/bin/env node
/**
 * Automated denial tests for the human approval channel.
 * A non-TTY / piped approve-interactive must fail.
 * Machine approve without PRAXIS_BROKER_MACHINE_APPROVE must fail.
 * This does NOT prove a human approved a plan.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const contracts = require(join(root, "packages/contracts/dist/index.js"));
const broker = join(root, "tools/broker/praxis-broker.mjs");

const work = mkdtempSync(join(tmpdir(), "praxis-human-deny-"));
const trusted = join(work, "trusted");
const shared = join(work, "shared");
mkdirSync(join(trusted, "audit"), { recursive: true });
mkdirSync(join(shared, "pending"), { recursive: true });
mkdirSync(join(shared, "authorizations"), { recursive: true });
writeFileSync(join(trusted, ".broker-identity"), "broker\n");
const keys = contracts.generateApprovalKeyPair();
writeFileSync(join(trusted, "private.pem"), keys.privateKeyPem);
writeFileSync(join(trusted, "public.pem"), keys.publicKeyPem);
writeFileSync(join(trusted, "credentials.json"), "{}\n");

const now = new Date();
const plan = contracts.buildActionPlan({
  planId: "deny-1",
  role: "developer",
  decisionKind: "development_action",
  summary: "Denial fixture",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: ["WP-1"],
  storyIds: [],
  decisionIds: [],
  repositories: [work],
  actions: [{ action: "praxis_workflow_apply", description: "noop", targets: [] }],
  risks: [],
  sideEffects: [],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
});
writeFileSync(join(shared, "pending", "deny-1.json"), `${JSON.stringify(plan, null, 2)}\n`);

const env = {
  ...process.env,
  PRAXIS_BROKER_TRUSTED_DIR: trusted,
  PRAXIS_BROKER_SHARED_DIR: shared,
  PRAXIS_APPROVAL_PRIVATE_KEY_PATH: join(trusted, "private.pem"),
  PRAXIS_CONTRACTS_ENTRY: join(root, "packages/contracts/dist/index.js"),
};
delete env.PRAXIS_BROKER_MACHINE_APPROVE;

const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

const machine = spawnSync("node", [broker, "approve", "--plan-id", "deny-1", "--approver", "agent"], {
  encoding: "utf8",
  env,
  input: "",
});
check("machine_approve_without_flag_refused", (machine.status ?? 1) !== 0);

const interactive = spawnSync("node", [broker, "approve-interactive", "--plan-id", "deny-1"], {
  encoding: "utf8",
  env,
  input: `APPROVE ${plan.fingerprint}\n`,
});
check("piped_interactive_approve_refused", (interactive.status ?? 1) !== 0);
check(
  "approve_interactive_disabled_for_pty_spoof",
  /PTY|operator-console|disabled/i.test(`${interactive.stdout}${interactive.stderr}`),
);

const threat = contracts.assessDeploymentThreats({ dockerSockets: ["/no/such/docker.sock"] });
check("threat_assessment_reports_mode", threat.mode === "compatibility" || threat.mode === "secure");

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? "HUMAN_DENIAL_TEST FAIL" : "HUMAN_DENIAL_TEST PASS");
process.exit(failed.length ? 1 : 0);
