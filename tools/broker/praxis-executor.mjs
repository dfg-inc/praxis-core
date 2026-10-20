#!/usr/bin/env node
/**
 * Privileged executor. Holds production write credentials under the broker identity.
 * The agent never receives PRAXIS_JIRA_TOKEN / git push credentials in secure mode.
 *
 * execute --token <file> --action <name> --payload <json-file>
 *
 * Fixture writes require PRAXIS_FIXTURE_EXECUTION=1 and a token bound to exact
 * targets and content. Unsupported production adapters fail closed.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveContainedTarget, writeApprovedFixtureFile } from "./fixture-execute.mjs";

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
  assertExecutionPayload,
  executionRequestFingerprint,
  reserveLedgerEntry,
  completeLedgerEntry,
  failLedgerEntry,
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

function executeFixture(body, request) {
  if (process.env.PRAXIS_FIXTURE_EXECUTION !== "1") {
    throw new Error("fixture execution is disabled; set PRAXIS_FIXTURE_EXECUTION=1 only in an isolated acceptance environment");
  }
  if (body.provider !== "local" || request.provider !== "local") {
    throw new Error("fixture execution requires provider=local");
  }
  if (request.action !== "praxis_workflow_apply" || body.action !== "praxis_workflow_apply") {
    throw new Error(`unsupported action ${request.action}; production adapters fail closed`);
  }
  if (request.operation !== "repository_edit") {
    throw new Error(`unsupported operation ${request.operation}; production adapters fail closed`);
  }
  if (body.content === undefined) {
    throw new Error("authorization does not bind exact content; refuse execution");
  }
  if (approvedContentDigest(body.content) !== request.contentDigest) {
    throw new Error("approved content does not match the bound digest");
  }
  const mutated = [];
  for (const target of request.targets) {
    const absolute = resolveContainedTarget(request.repository, target);
    const written = writeApprovedFixtureFile(absolute, body.content);
    mutated.push({
      path: written.path,
      bytes: written.bytes,
      contentDigest: request.contentDigest,
    });
  }
  if (!mutated.length) {
    throw new Error("approved fixture mutation listed no targets");
  }
  return {
    executed: request.action,
    provider: "local",
    instanceId: request.instanceId,
    workItemIds: body.workItemIds,
    credentialOwner: "executor",
    fixture: true,
    mutated,
  };
}

function cmdExecute() {
  assertExecutorIdentity();
  if (process.env.PRAXIS_APPROVAL_PRIVATE_KEY || process.env.PRAXIS_APPROVAL_PRIVATE_KEY_PATH) {
    throw new Error("executor must not load the approval signing key");
  }
  const tokenFile = arg("--token");
  const action = arg("--action");
  const payloadFile = arg("--payload");
  if (!tokenFile || !action || !payloadFile) {
    throw new Error("--token, --action, and --payload are required");
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  const publicKey = readFileSync(mustEnv("PRAXIS_APPROVAL_PUBLIC_KEY_PATH"), "utf8");
  const ledger = resolve(mustEnv("PRAXIS_APPROVAL_LEDGER"));
  const body = verifyAuthorization(token, publicKey);
  const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
  const request = assertExecutionPayload(payload, body, action);
  const requestFingerprint = executionRequestFingerprint(request);

  const reserved = reserveLedgerEntry(ledger, body.consumptionId, requestFingerprint);
  if (!reserved.created) {
    if (reserved.entry.requestFingerprint && reserved.entry.requestFingerprint !== requestFingerprint) {
      throw new Error("same token is bound to a different execution request; refuse");
    }
    if (reserved.entry.status === "completed") {
      console.log(JSON.stringify({ ok: true, replayed: true, result: reserved.entry.result }));
      return;
    }
    if (reserved.entry.status === "started") {
      throw new Error("authorization consumption is already in progress; reconcile before retry");
    }
    throw new Error(`authorization consumption is ${reserved.entry.status}; refuse uncontrolled retry`);
  }

  try {
    loadCredentials();
    const result = executeFixture(body, request);
    completeLedgerEntry(ledger, body.consumptionId, requestFingerprint, result);
    console.log(JSON.stringify({ ok: true, replayed: false, result }));
  } catch (error) {
    failLedgerEntry(
      ledger,
      body.consumptionId,
      requestFingerprint,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
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
      fixtureExecution: process.env.PRAXIS_FIXTURE_EXECUTION === "1",
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
