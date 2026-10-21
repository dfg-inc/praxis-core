/** Executable Quality checks for the Runtime client of the Approval Service (service-integration level; same OS user). */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { assessApprovalService, callApprovalService, parseServiceRequest } from "./dist/index.js";

/** The Desktop runtime's own process.execPath is not a Node that can be spawned; find a real one. */
function nodeBinary() {
  for (const candidate of [process.env.PRAXIS_NODE, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) if (candidate && existsSync(candidate)) return candidate;
  return "node";
}

export function protocolHasNoApprovePath() {
  const refused = ["approve", "reject", "sign", "enroll", "set-config", "exec", "shell", "grant"].map((op) => parseServiceRequest({ protocol: "praxis.approval-service.v1", op }).code);
  return {
    refused: [...new Set(refused)],
    strictExtraFieldRefused: parseServiceRequest({ protocol: "praxis.approval-service.v1", op: "execute", requestId: "x", authorization: "t" }).code,
    allowed: ["health", "status", "execute"].map((op) => parseServiceRequest({ protocol: "praxis.approval-service.v1", op, ...(op === "health" ? {} : { requestId: "x" }) }).ok),
  };
}

export async function impostorAndDeadServiceAreNotTrusted() {
  const dir = mkdtempSync("/tmp/pas-q-");
  const endpoint = join(dir, "fake.sock");
  const health = { service: "praxis-approval-service", version: "9", protocol: "praxis.approval-service.v1", mode: "production", platform: "x", uptimeSec: 1, isolation: { verified: true, principal: "x", checks: [] }, operatorChannel: { url: "x", enrolledAuthenticators: 1 }, pending: 0, auditChain: { ok: true, entries: 0 }, ledgerEntries: 0 };
  const fake = createServer((s) => s.end(`${JSON.stringify({ ok: true, protocol: "praxis.approval-service.v1", health })}\n`));
  await new Promise((r) => fake.listen(endpoint, r));
  try {
    const impostor = await assessApprovalService({ endpoint });
    fake.close();
    const dead = await assessApprovalService({ endpoint: join(dir, "nothing.sock") });
    let callError = "none";
    try {
      await callApprovalService({ op: "health" }, { endpoint: join(dir, "nothing.sock"), timeoutMs: 500 });
    } catch (error) {
      callError = error.code;
    }
    return { impostorReachable: impostor.reachable, impostorIsolated: impostor.isolated, deadReachable: dead.reachable, deadIsolated: dead.isolated, callToDeadService: callError };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The Desktop path: the packaged MCPB (from the sibling Runtime repository) delegating to a real service process. */
export async function desktopMcpbDelegation() {
  const { spawnSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const runtime = process.env.PRAXIS_RUNTIME_ROOT ?? resolve(import.meta.dirname, "../../../praxis-runtime");
  const script = resolve(runtime, "tools/scripts/service-delegation-acceptance.mjs");
  if (!existsSync(script)) return { result: "BLOCKED: the Runtime repository is not available", steps: 0 };
  const run = spawnSync(nodeBinary(), [script], { cwd: runtime, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 900_000, env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`, PRAXIS_CORE_ROOT: resolve(import.meta.dirname, "../..") } });
  const pass = run.stdout.split("\n").find((l) => l.startsWith("PASS service-delegation"));
  return { result: pass ? "PASS service-delegation" : `FAIL: ${(run.stdout + run.stderr).slice(-300)}`, steps: run.stdout.split("\n").filter((l) => /^ {2}ok \d/.test(l)).length };
}

/** The CLI path: a repository file must not point the Runtime at another service or change the security mode. */
export async function cliCannotBeRedirectedByRepositoryFile() {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { loadPraxisDotenv, dotenvRejectedKeys } = await import("../cli/dist/operations.js");
  const repo = mkdtempSync("/tmp/pas-q-");
  const saved = { a: process.env.PRAXIS_APPROVAL_SERVICE_ENDPOINT, b: process.env.PRAXIS_SECURITY_MODE, c: process.env.PRAXIS_SKIP_DOTENV };
  delete process.env.PRAXIS_APPROVAL_SERVICE_ENDPOINT;
  delete process.env.PRAXIS_SECURITY_MODE;
  delete process.env.PRAXIS_SKIP_DOTENV;
  try {
    writeFileSync(join(repo, ".env"), "PRAXIS_APPROVAL_SERVICE_ENDPOINT=/tmp/attacker.sock\nPRAXIS_SECURITY_MODE=compatibility\n");
    loadPraxisDotenv(repo);
    return { endpointFromRepoFile: process.env.PRAXIS_APPROVAL_SERVICE_ENDPOINT ?? null, securityModeFromRepoFile: process.env.PRAXIS_SECURITY_MODE ?? null, rejected: ["PRAXIS_APPROVAL_SERVICE_ENDPOINT", "PRAXIS_SECURITY_MODE"].filter((k) => dotenvRejectedKeys().includes(k)) };
  } finally {
    for (const [k, v] of Object.entries({ PRAXIS_APPROVAL_SERVICE_ENDPOINT: saved.a, PRAXIS_SECURITY_MODE: saved.b, PRAXIS_SKIP_DOTENV: saved.c })) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(repo, { recursive: true, force: true });
  }
}
