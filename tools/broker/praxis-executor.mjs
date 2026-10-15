#!/usr/bin/env node
/**
 * Privileged executor. Holds production write credentials under the broker identity.
 * The agent never receives PRAXIS_JIRA_TOKEN / git push credentials in secure mode.
 *
 * execute --token <file> --action <name> --payload <json-file>
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function loadContracts() {
  const candidates = [
    process.env.PRAXIS_CONTRACTS_ENTRY,
    join(dirname(fileURLToPath(import.meta.url)), "../../packages/contracts/dist/index.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error("cannot load @praxis/contracts");
}

const {
  verifyAuthorization,
  authorizationMatches,
  readLedgerEntry,
  writeLedgerEntry,
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

function assertExecutorIdentity() {
  const trusted = resolve(mustEnv("PRAXIS_BROKER_TRUSTED_DIR"));
  if (!existsSync(join(trusted, ".broker-identity"))) {
    throw new Error("executor identity marker missing");
  }
  accessSync(join(trusted, "credentials.json"), constants.R_OK);
}

function loadCredentials() {
  return JSON.parse(readFileSync(join(resolve(mustEnv("PRAXIS_BROKER_TRUSTED_DIR")), "credentials.json"), "utf8"));
}

function cmdExecute() {
  assertExecutorIdentity();
  if (process.env.PRAXIS_APPROVAL_PRIVATE_KEY || process.env.PRAXIS_APPROVAL_PRIVATE_KEY_PATH) {
    throw new Error("executor must not load the approval signing key");
  }
  const tokenFile = arg("--token");
  const action = arg("--action");
  const payloadFile = arg("--payload");
  if (!tokenFile || !action) throw new Error("--token and --action are required");
  const token = readFileSync(tokenFile, "utf8").trim();
  const publicKey = readFileSync(mustEnv("PRAXIS_APPROVAL_PUBLIC_KEY_PATH"), "utf8");
  const ledger = resolve(mustEnv("PRAXIS_APPROVAL_LEDGER"));
  const body = verifyAuthorization(token, publicKey);
  const payload = payloadFile ? JSON.parse(readFileSync(payloadFile, "utf8")) : {};
  authorizationMatches(body, {
    planFingerprint: payload.planFingerprint ?? body.planFingerprint,
    provider: payload.provider ?? body.provider,
    instanceId: payload.instanceId ?? body.instanceId,
    operation: payload.operation ?? body.operations[0],
    action,
    workItemId: payload.workItemId,
    repository: payload.repository,
  });
  const existing = readLedgerEntry(ledger, body.consumptionId);
  if (existing?.status === "completed") {
    console.log(JSON.stringify({ ok: true, replayed: true, result: existing.result }));
    return;
  }
  if (existing?.status === "started") {
    throw new Error("authorization consumption is already in progress; reconcile before retry");
  }
  writeLedgerEntry(ledger, body.consumptionId, { status: "started" });
  const credentials = loadCredentials();
  if (action.startsWith("praxis_") && !credentials.jiraToken && payload.provider === "jira") {
    throw new Error("executor credentials missing for Jira write");
  }
  const result = {
    executed: action,
    provider: body.provider,
    workItemIds: body.workItemIds,
    credentialOwner: "executor",
    usedJiraToken: Boolean(credentials.jiraToken) && body.provider === "jira",
    note: "fixture execution — no production write",
  };
  writeLedgerEntry(ledger, body.consumptionId, { status: "completed", result });
  console.log(JSON.stringify({ ok: true, replayed: false, result }));
}

function cmdHealth() {
  assertExecutorIdentity();
  const credentials = loadCredentials();
  console.log(
    JSON.stringify({
      ok: true,
      hasJiraToken: Boolean(credentials.jiraToken),
      hasGitToken: Boolean(credentials.gitToken),
      ledger: process.env.PRAXIS_APPROVAL_LEDGER,
    }),
  );
}

const cmd = process.argv[2];
try {
  if (cmd === "execute") cmdExecute();
  else if (cmd === "health") cmdHealth();
  else {
    console.error("usage: praxis-executor.mjs execute|health");
    process.exit(2);
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
