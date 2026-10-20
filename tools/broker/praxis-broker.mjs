#!/usr/bin/env node
/**
 * Trusted approval broker. Must run as the broker OS identity.
 * The agent must not be able to read PRAXIS_APPROVAL_PRIVATE_KEY_PATH or call approve.
 *
 * Commands:
 *   propose  --plan <file>     record a pending plan under the shared inbox
 *   show     --plan-id <id>    render the exact plan for the human operator
 *   approve  --plan-id <id> --approver <id>   machine sign (PRAXIS_BROKER_MACHINE_APPROVE=1 only)
 *   approve-interactive                       REFUSED — TTY alone is not human authentication
 *   serve-operator                            Unix socket in trusted dir for human console
 *   reject   --plan-id <id>
 *   health
 *
 * Humans must use praxis-operator-console.mjs against serve-operator.
 */
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadContracts() {
  const candidates = [
    process.env.PRAXIS_CONTRACTS_ENTRY,
    join(dirname(fileURLToPath(import.meta.url)), "../../packages/contracts/dist/index.js"),
    join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/@praxis/contracts/dist/index.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* try next */
    }
  }
  throw new Error("cannot load @praxis/contracts; set PRAXIS_CONTRACTS_ENTRY");
}

const {
  encodeAuthorization,
  signAuthorization,
  renderActionPlanForHuman,
  ActionPlanSchema,
  AUTHORIZATION_CONTRACT,
  AUTHORIZATION_VERSION,
  approvedContentDigest,
} = loadContracts();

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function mustEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function trustedRoot() {
  return resolve(mustEnv("PRAXIS_BROKER_TRUSTED_DIR"));
}

function sharedRoot() {
  return resolve(mustEnv("PRAXIS_BROKER_SHARED_DIR"));
}

function privateKeyPem() {
  const inline = process.env.PRAXIS_APPROVAL_PRIVATE_KEY?.trim();
  if (inline) return inline;
  const path = mustEnv("PRAXIS_APPROVAL_PRIVATE_KEY_PATH");
  accessSync(path, constants.R_OK);
  return readFileSync(path, "utf8");
}

function assertBrokerIdentity() {
  const marker = join(trustedRoot(), ".broker-identity");
  if (!existsSync(marker)) {
    throw new Error("broker identity marker missing; refusing to run as untrusted process");
  }
  try {
    accessSync(join(trustedRoot(), "private.pem"), constants.R_OK);
  } catch {
    throw new Error("broker cannot read private.pem; wrong identity");
  }
}

function pendingPath(planId) {
  return join(sharedRoot(), "pending", `${planId}.json`);
}

function authPath(planId) {
  return join(sharedRoot(), "authorizations", `${planId}.token`);
}

function cmdPropose() {
  const planFile = arg("--plan");
  if (!planFile) throw new Error("--plan is required");
  const plan = ActionPlanSchema.parse(JSON.parse(readFileSync(planFile, "utf8")));
  mkdirSync(join(sharedRoot(), "pending"), { recursive: true });
  const dest = pendingPath(plan.planId);
  writeFileSync(dest, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, planId: plan.planId, fingerprint: plan.fingerprint, path: dest }));
}

function cmdShow() {
  const planId = arg("--plan-id");
  if (!planId) throw new Error("--plan-id is required");
  const plan = ActionPlanSchema.parse(JSON.parse(readFileSync(pendingPath(planId), "utf8")));
  console.log(renderActionPlanForHuman(plan));
}

function signApprovedPlan(plan, approver, channel) {
  const now = new Date();
  const approvedAction = plan.actions[0];
  const content = approvedAction.content ?? "";
  const body = {
    contract: AUTHORIZATION_CONTRACT,
    version: AUTHORIZATION_VERSION,
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    provider: plan.provider,
    instanceId: plan.instanceId,
    operations: plan.operations,
    workItemIds: plan.workItemIds,
    repositories: plan.repositories,
    action: approvedAction.action,
    targets: approvedAction.targets,
    decisionKind: plan.decisionKind,
    content,
    contentDigest: approvedContentDigest(content),
    approver,
    issuedAt: now.toISOString(),
    expiresAt: plan.expiresAt,
    consumptionId: `c-${createHash("sha256").update(`${plan.planId}:${randomUUID()}`).digest("hex").slice(0, 24)}`,
  };
  const token = encodeAuthorization(signAuthorization(body, privateKeyPem()));
  mkdirSync(join(sharedRoot(), "authorizations"), { recursive: true });
  const tmp = `${authPath(plan.planId)}.tmp`;
  writeFileSync(tmp, token);
  renameSync(tmp, authPath(plan.planId));
  mkdirSync(join(trustedRoot(), "audit"), { recursive: true });
  writeFileSync(
    join(trustedRoot(), "audit", `${plan.planId}.json`),
    `${JSON.stringify({
      planId: plan.planId,
      fingerprint: plan.fingerprint,
      approver,
      channel,
      at: now.toISOString(),
      consumptionId: body.consumptionId,
    }, null, 2)}\n`,
  );
  return { ok: true, planId: plan.planId, tokenPath: authPath(plan.planId), consumptionId: body.consumptionId, channel };
}

function cmdApprove() {
  assertBrokerIdentity();
  if (process.env.PRAXIS_BROKER_MACHINE_APPROVE !== "1") {
    throw new Error(
      "machine approve requires PRAXIS_BROKER_MACHINE_APPROVE=1 under the broker identity; humans must use praxis-operator-console.mjs",
    );
  }
  const planId = arg("--plan-id");
  const approver = arg("--approver") || "operator";
  if (!planId) throw new Error("--plan-id is required");
  const plan = ActionPlanSchema.parse(JSON.parse(readFileSync(pendingPath(planId), "utf8")));
  console.log(JSON.stringify(signApprovedPlan(plan, approver, "machine")));
}

function cmdApproveInteractive() {
  throw new Error(
    "approve-interactive is disabled: a PTY can spoof TTY input. Use praxis-operator-console.mjs against serve-operator on the broker operator socket",
  );
}

function operatorSocketPath() {
  return join(trustedRoot(), "operator.sock");
}

function handleOperatorMessage(message) {
  assertBrokerIdentity();
  if (message.cmd === "show") {
    const plan = ActionPlanSchema.parse(JSON.parse(readFileSync(pendingPath(message.planId), "utf8")));
    return {
      ok: true,
      planId: plan.planId,
      fingerprint: plan.fingerprint,
      text: renderActionPlanForHuman(plan),
    };
  }
  if (message.cmd === "reject") {
    const dest = pendingPath(message.planId);
    if (existsSync(dest)) {
      mkdirSync(join(sharedRoot(), "rejected"), { recursive: true });
      renameSync(dest, join(sharedRoot(), "rejected", `${message.planId}.json`));
    }
    mkdirSync(join(trustedRoot(), "audit"), { recursive: true });
    writeFileSync(
      join(trustedRoot(), "audit", `${message.planId}.json`),
      `${JSON.stringify({
        planId: message.planId,
        state: "rejected",
        approver: message.approver || "operator",
        channel: "operator-socket",
        at: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    return { ok: true, planId: message.planId, state: "rejected", channel: "operator-socket" };
  }
  if (message.cmd === "approve") {
    const plan = ActionPlanSchema.parse(JSON.parse(readFileSync(pendingPath(message.planId), "utf8")));
    if (message.fingerprint !== plan.fingerprint) {
      throw new Error("operator socket approval fingerprint mismatch");
    }
    return signApprovedPlan(plan, message.approver || "operator", "operator-socket");
  }
  throw new Error(`unsupported operator command ${message.cmd}`);
}

function cmdServeOperator() {
  assertBrokerIdentity();
  const socketPath = operatorSocketPath();
  try {
    unlinkSync(socketPath);
  } catch {
    /* absent */
  }
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let response;
      try {
        response = handleOperatorMessage(JSON.parse(line));
      } catch (error) {
        response = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      socket.write(`${JSON.stringify(response)}\n`);
      socket.end();
    });
  });
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
    console.log(JSON.stringify({ ok: true, listening: socketPath, channel: "operator-socket" }));
  });
}

function cmdReject() {
  assertBrokerIdentity();
  const planId = arg("--plan-id");
  if (!planId) throw new Error("--plan-id is required");
  const dest = pendingPath(planId);
  if (existsSync(dest)) {
    mkdirSync(join(sharedRoot(), "rejected"), { recursive: true });
    renameSync(dest, join(sharedRoot(), "rejected", `${planId}.json`));
  }
  console.log(JSON.stringify({ ok: true, planId, state: "rejected" }));
}

function cmdHealth() {
  const trusted = trustedRoot();
  const shared = sharedRoot();
  const pending = existsSync(join(shared, "pending")) ? readdirSync(join(shared, "pending")).length : 0;
  console.log(
    JSON.stringify({
      ok: true,
      trusted,
      shared,
      pending,
      brokerIdentity: existsSync(join(trusted, ".broker-identity")),
      privateKeyReadable: (() => {
        try {
          accessSync(join(trusted, "private.pem"), constants.R_OK);
          return true;
        } catch {
          return false;
        }
      })(),
    }),
  );
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "propose") cmdPropose();
  else if (cmd === "show") cmdShow();
  else if (cmd === "approve") cmdApprove();
  else if (cmd === "approve-interactive") cmdApproveInteractive();
  else if (cmd === "serve-operator") cmdServeOperator();
  else if (cmd === "reject") cmdReject();
  else if (cmd === "health") cmdHealth();
  else {
    console.error(
      "usage: praxis-broker.mjs propose|show|approve|approve-interactive|serve-operator|reject|health",
    );
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
