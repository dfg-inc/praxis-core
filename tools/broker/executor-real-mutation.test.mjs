#!/usr/bin/env node
/**
 * Milestone 1.5 hotfix: real fixture side effects, not JSON flags alone.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { FIXTURE_ACCEPTED_CONTENT } from "./fixture-execute.mjs";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const contracts = require(join(root, "packages/contracts/dist/index.js"));
const broker = join(root, "tools/broker/praxis-broker.mjs");
const executor = join(root, "tools/broker/praxis-executor.mjs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const work = mkdtempSync(join(tmpdir(), "praxis-exec-real-"));
const trusted = join(work, "trusted");
const shared = join(work, "shared");
const project = join(work, "project");
const ledger = join(trusted, "ledger");
mkdirSync(join(trusted, "audit"), { recursive: true });
mkdirSync(ledger, { recursive: true });
mkdirSync(join(shared, "pending"), { recursive: true });
mkdirSync(join(shared, "authorizations"), { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(join(trusted, ".broker-identity"), "broker\n");
const keys = contracts.generateApprovalKeyPair();
writeFileSync(join(trusted, "private.pem"), keys.privateKeyPem);
writeFileSync(join(trusted, "public.pem"), keys.publicKeyPem);
writeFileSync(join(trusted, "credentials.json"), JSON.stringify({ jiraToken: "SYNTHETIC" }));
chmodSync(join(trusted, "private.pem"), 0o600);

const now = new Date();
const accepted = join(project, "accepted.txt");
const rejectPlan = contracts.buildActionPlan({
  planId: "hot-reject-1",
  role: "developer",
  decisionKind: "development_action",
  summary: "REJECT — must not write",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: ["WP-REJECT"],
  storyIds: [],
  decisionIds: [],
  repositories: [project],
  actions: [
    {
      action: "praxis_workflow_apply",
      description: "would write accepted.txt",
      targets: [accepted],
      content: FIXTURE_ACCEPTED_CONTENT,
    },
  ],
  risks: [],
  sideEffects: [],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 600_000).toISOString(),
});
const approvePlan = contracts.buildActionPlan({
  planId: "hot-approve-1",
  role: "developer",
  decisionKind: "development_action",
  summary: "Approve accepted.txt",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: ["WP-OK"],
  storyIds: [],
  decisionIds: [],
  repositories: [project],
  actions: [
    {
      action: "praxis_workflow_apply",
      description: "create accepted.txt once",
      targets: [accepted],
      content: FIXTURE_ACCEPTED_CONTENT,
    },
  ],
  risks: [],
  sideEffects: ["writes accepted.txt"],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 600_000).toISOString(),
});
writeFileSync(join(shared, "pending", "hot-reject-1.json"), `${JSON.stringify(rejectPlan, null, 2)}\n`);
writeFileSync(join(shared, "pending", "hot-approve-1.json"), `${JSON.stringify(approvePlan, null, 2)}\n`);

const brokerEnv = {
  ...process.env,
  PRAXIS_BROKER_TRUSTED_DIR: trusted,
  PRAXIS_BROKER_SHARED_DIR: shared,
  PRAXIS_APPROVAL_PRIVATE_KEY_PATH: join(trusted, "private.pem"),
  PRAXIS_CONTRACTS_ENTRY: join(root, "packages/contracts/dist/index.js"),
  PRAXIS_BROKER_MACHINE_APPROVE: "1",
};
const execEnv = {
  ...process.env,
  PRAXIS_BROKER_TRUSTED_DIR: trusted,
  PRAXIS_BROKER_SHARED_DIR: shared,
  PRAXIS_APPROVAL_PUBLIC_KEY_PATH: join(trusted, "public.pem"),
  PRAXIS_APPROVAL_LEDGER: ledger,
  PRAXIS_CONTRACTS_ENTRY: join(root, "packages/contracts/dist/index.js"),
  PRAXIS_FIXTURE_EXECUTION: "1",
};
delete execEnv.PRAXIS_APPROVAL_PRIVATE_KEY_PATH;
delete execEnv.PRAXIS_APPROVAL_PRIVATE_KEY;

function payloadFor(plan, overrides = {}) {
  return {
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    provider: plan.provider,
    instanceId: plan.instanceId,
    operation: plan.operations[0],
    action: plan.actions[0].action,
    workItemId: plan.workItemIds[0],
    repository: plan.repositories[0],
    targets: plan.actions[0].targets,
    contentDigest: contracts.approvedContentDigest(plan.actions[0].content),
    ...overrides,
  };
}

function runExec(token, action, payload, extraEnv = {}) {
  const payloadPath = join(work, `payload-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`);
  return spawnSync("node", [executor, "execute", "--token", token, "--action", action, "--payload", payloadPath], {
    encoding: "utf8",
    env: { ...execEnv, ...extraEnv },
  });
}

check("before_approval_file_absent", !existsSync(accepted));

spawnSync("node", [broker, "reject", "--plan-id", "hot-reject-1"], { encoding: "utf8", env: brokerEnv });
check("rejected_plan_does_not_create_file", !existsSync(accepted));

const approved = spawnSync("node", [broker, "approve", "--plan-id", "hot-approve-1", "--approver", "operator"], {
  encoding: "utf8",
  env: brokerEnv,
});
check("broker_approved", (approved.status ?? 1) === 0, approved.stdout);
const token = join(shared, "authorizations", "hot-approve-1.token");

const first = runExec(token, "praxis_workflow_apply", payloadFor(approvePlan));
const firstJson = (() => {
  try {
    return JSON.parse(first.stdout);
  } catch {
    return {};
  }
})();
check(
  "approved_plan_creates_file",
  (first.status ?? 1) === 0 &&
    firstJson.replayed === false &&
    existsSync(accepted) &&
    readFileSync(accepted, "utf8") === FIXTURE_ACCEPTED_CONTENT,
  first.stderr || first.stdout,
);

const ledgerFiles = spawnSync("bash", ["-lc", `ls ${ledger}`], { encoding: "utf8" });
let completed = false;
for (const name of (ledgerFiles.stdout || "").trim().split("\n").filter(Boolean)) {
  const entry = JSON.parse(readFileSync(join(ledger, name), "utf8"));
  if (
    entry.status === "completed" &&
    entry.result?.mutated?.[0]?.contentDigest === contracts.approvedContentDigest(FIXTURE_ACCEPTED_CONTENT) &&
    /accepted\.txt$/.test(entry.result?.mutated?.[0]?.path || "")
  ) {
    completed = true;
  }
}
check("ledger_records_actual_success", completed);

const firstStat = existsSync(accepted) ? readFileSync(accepted, "utf8") : "";
if (existsSync(accepted)) utimesSync(accepted, new Date(0), new Date(0));
const second = runExec(token, "praxis_workflow_apply", payloadFor(approvePlan));
const secondJson = (() => {
  try {
    return JSON.parse(second.stdout);
  } catch {
    return {};
  }
})();
const mtime = spawnSync("stat", ["-f", "%m", accepted], { encoding: "utf8" });
check(
  "exact_replay_does_not_modify_file",
  (second.status ?? 1) === 0 &&
    secondJson.replayed === true &&
    readFileSync(accepted, "utf8") === firstStat &&
    (mtime.stdout || "").trim() === "0",
  second.stdout,
);

const alteredContent = runExec(
  token,
  "praxis_workflow_apply",
  payloadFor(approvePlan, { contentDigest: contracts.approvedContentDigest("evil\n") }),
);
check("altered_payload_rejected", (alteredContent.status ?? 1) !== 0);

const alteredTarget = runExec(
  token,
  "praxis_workflow_apply",
  payloadFor(approvePlan, { targets: [join(project, "other.txt")] }),
);
check("altered_target_rejected", (alteredTarget.status ?? 1) !== 0 && !existsSync(join(project, "other.txt")));

const traversal = runExec(
  token,
  "praxis_workflow_apply",
  payloadFor(approvePlan, { targets: [join(project, "..", "escape.txt")] }),
);
check("path_traversal_rejected", (traversal.status ?? 1) !== 0 && !existsSync(join(work, "escape.txt")));

const link = join(project, "escape-link");
symlinkSync(work, link);
const symlinkEscape = runExec(
  token,
  "praxis_workflow_apply",
  payloadFor(approvePlan, { targets: [join(link, "pwned.txt")] }),
);
check("symlink_escape_rejected", (symlinkEscape.status ?? 1) !== 0 && !existsSync(join(work, "pwned.txt")));

const jiraPlan = contracts.buildActionPlan({
  planId: "hot-jira-1",
  role: "developer",
  decisionKind: "issue_tracker_mutation",
  summary: "Unsupported Jira write",
  provider: "jira",
  instanceId: "https://jira.example",
  operations: ["external_record_update"],
  workItemIds: ["JIRA-1"],
  storyIds: [],
  decisionIds: [],
  repositories: [project],
  actions: [{ action: "praxis_workflow_apply", description: "jira", targets: ["JIRA-1"] }],
  risks: [],
  sideEffects: [],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 600_000).toISOString(),
});
writeFileSync(join(shared, "pending", "hot-jira-1.json"), `${JSON.stringify(jiraPlan, null, 2)}\n`);
spawnSync("node", [broker, "approve", "--plan-id", "hot-jira-1", "--approver", "operator"], {
  encoding: "utf8",
  env: brokerEnv,
});
const jiraExec = runExec(join(shared, "authorizations", "hot-jira-1.token"), "praxis_workflow_apply", payloadFor({
  ...jiraPlan,
  actions: [{ ...jiraPlan.actions[0], content: "" }],
}, { contentDigest: contracts.approvedContentDigest("") }));
const jiraLedgerAfter = spawnSync("bash", ["-lc", `ls ${ledger}`], { encoding: "utf8" });
let jiraCompleted = false;
for (const name of (jiraLedgerAfter.stdout || "").trim().split("\n").filter(Boolean)) {
  const entry = JSON.parse(readFileSync(join(ledger, name), "utf8"));
  if (entry.result?.executed && entry.status === "completed" && name.includes("jira")) jiraCompleted = true;
}
check(
  "unsupported_production_fails_closed",
  (jiraExec.status ?? 1) !== 0 && /fail closed|unsupported|provider/i.test(`${jiraExec.stdout}${jiraExec.stderr}`) && !jiraCompleted,
  jiraExec.stderr || jiraExec.stdout,
);

const failPlan = contracts.buildActionPlan({
  planId: "hot-fail-1",
  role: "developer",
  decisionKind: "development_action",
  summary: "Preflight fail",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: ["WP-FAIL"],
  storyIds: [],
  decisionIds: [],
  repositories: [project],
  actions: [
    {
      action: "praxis_workflow_apply",
      description: "fixture without flag",
      targets: [join(project, "should-not-exist.txt")],
      content: FIXTURE_ACCEPTED_CONTENT,
    },
  ],
  risks: [],
  sideEffects: [],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 600_000).toISOString(),
});
writeFileSync(join(shared, "pending", "hot-fail-1.json"), `${JSON.stringify(failPlan, null, 2)}\n`);
spawnSync("node", [broker, "approve", "--plan-id", "hot-fail-1", "--approver", "operator"], {
  encoding: "utf8",
  env: brokerEnv,
});
const failedPreflight = runExec(
  join(shared, "authorizations", "hot-fail-1.token"),
  "praxis_workflow_apply",
  payloadFor(failPlan),
  { PRAXIS_FIXTURE_EXECUTION: "" },
);
const failEntries = [];
for (const name of spawnSync("bash", ["-lc", `ls ${ledger}`], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean)) {
  failEntries.push(JSON.parse(readFileSync(join(ledger, name), "utf8")));
}
const failCompleted = failEntries.some(
  (entry) => entry.status === "completed" && entry.result?.mutated?.some((item) => /should-not-exist/.test(item.path || "")),
);
check(
  "failed_preflight_no_false_success",
  (failedPreflight.status ?? 1) !== 0 && !existsSync(join(project, "should-not-exist.txt")) && !failCompleted,
);

const concPlan = contracts.buildActionPlan({
  planId: "hot-conc-1",
  role: "developer",
  decisionKind: "development_action",
  summary: "Concurrent write",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: ["WP-CONC"],
  storyIds: [],
  decisionIds: [],
  repositories: [project],
  actions: [
    {
      action: "praxis_workflow_apply",
      description: "concurrent accepted-conc.txt",
      targets: [join(project, "accepted-conc.txt")],
      content: FIXTURE_ACCEPTED_CONTENT,
    },
  ],
  risks: [],
  sideEffects: [],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 600_000).toISOString(),
});
writeFileSync(join(shared, "pending", "hot-conc-1.json"), `${JSON.stringify(concPlan, null, 2)}\n`);
spawnSync("node", [broker, "approve", "--plan-id", "hot-conc-1", "--approver", "operator"], {
  encoding: "utf8",
  env: brokerEnv,
});
const concToken = join(shared, "authorizations", "hot-conc-1.token");
const concPayload = join(work, "conc-payload.json");
writeFileSync(concPayload, `${JSON.stringify(payloadFor(concPlan))}\n`);

function spawnExec() {
  return spawn("node", [executor, "execute", "--token", concToken, "--action", "praxis_workflow_apply", "--payload", concPayload], {
    encoding: "utf8",
    env: execEnv,
  });
}

const a = spawnExec();
const b = spawnExec();
const [outA, outB] = await Promise.all([
  new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    a.stdout.on("data", (d) => (stdout += d));
    a.stderr.on("data", (d) => (stderr += d));
    a.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  }),
  new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    b.stdout.on("data", (d) => (stdout += d));
    b.stderr.on("data", (d) => (stderr += d));
    b.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  }),
]);
const outcomes = [outA, outB];
const successes = outcomes.filter((item) => item.code === 0);
const firstWrites = successes.filter((item) => /"replayed":false/.test(item.stdout));
check(
  "concurrent_at_most_one_execution",
  existsSync(join(project, "accepted-conc.txt")) &&
    readFileSync(join(project, "accepted-conc.txt"), "utf8") === FIXTURE_ACCEPTED_CONTENT &&
    firstWrites.length === 1 &&
    successes.length >= 1,
  `${firstWrites.length} first-writes, ${successes.length} successes`,
);

const failed = results.filter((item) => !item.ok);
console.log(failed.length ? "EXECUTOR_REAL_MUTATION FAIL" : "EXECUTOR_REAL_MUTATION PASS");
process.exit(failed.length ? 1 : 0);
