/**
 * The Approval Service core: platform-independent. It owns the signing key, the replay ledger, the audit chain, the
 * operator (WebAuthn) page, and the trusted executor. The agent-facing IPC has four messages and none approves.
 *
 *   state/                     0700, owned by the service principal, outside every user repository
 *     trusted/                 private.pem, public.pem, operators.json (enrolled authenticators), enroll.json
 *     shared/{pending,approved,rejected,authorizations}   the broker inbox, private to the service
 *     requests/<id>.json       the exact request as the service derived it
 *     ledger/<consumptionId>.json   one row per approval consumed (replay protection and recorded results)
 *     audit/chain.jsonl        hash-chained audit log
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { join, resolve } from "node:path";
import {
  APPROVAL_SERVICE_PROTOCOL,
  ActionPlanSchema,
  AUTHORIZATION_CONTRACT,
  AUTHORIZATION_VERSION,
  MAX_MESSAGE_BYTES,
  approvedContentDigest,
  assertTokenBindsPlan,
  buildGitPlan,
  completeLedgerEntry,
  encodeAuthorization,
  failLedgerEntry,
  generateApprovalKeyPair,
  gitPlanId,
  gitRequestContent,
  parseServiceRequest,
  planTtlMs,
  productionBuild,
  readLedgerEntry,
  rebuildWithTimes,
  renderActionPlanForHuman,
  reserveLedgerEntry,
  signAuthorization,
  verifyAuthorization,
} from "../../../packages/contracts/dist/index.js";
import { createOperatorWeb, writeTokenOnce } from "../../broker/operator-web.mjs";
import { createAudit } from "./audit.mjs";
import { createExecutor } from "./executor.mjs";
import { GitxError } from "./gitx.mjs";
import { createProviders } from "./providers.mjs";

const ACTIONS = { git_commit: "praxis_approval_service.git_commit", git_push: "praxis_approval_service.git_push", merge_request: "praxis_approval_service.git_merge_request" };
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export class ServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const atomicWrite = (path, text, mode = 0o600) => {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
};

/**
 * @param {object} options
 * @param {object} options.paths      adapter paths (stateDir, endpoint, ...)
 * @param {object} options.config     parsed service configuration (allow-list, credentials, providers, operator port)
 * @param {"production"|"development"} options.mode
 * @param {(ctx:object)=>{id:string,ok:boolean,detail:string}[]} options.probe  adapter isolation probe
 */
export async function createService({ paths, config, mode, version, platformId, probe, fetchImpl, now = () => new Date() }) {
  if (mode !== "production" && mode !== "development") throw new ServiceError("BAD_MODE", "mode must be production or development");
  if (mode === "development" && productionBuild()) throw new ServiceError("DEV_MODE_REFUSED", "this is a production build: development mode is not available");

  const state = paths.stateDir;
  const dirs = {
    trusted: join(state, "trusted"),
    shared: join(state, "shared"),
    requests: join(state, "requests"),
    ledger: join(state, "ledger"),
    audit: join(state, "audit"),
  };
  for (const dir of [state, dirs.trusted, dirs.requests, dirs.ledger, dirs.audit, ...["pending", "approved", "rejected", "authorizations"].map((d) => join(dirs.shared, d))]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const isolationNow = () => {
    const checks = probe({ paths, config });
    return { verified: mode === "production" && checks.every((c) => c.ok), principal: config.principal ?? "unknown", checks };
  };

  // Fail closed: a production service with unverified isolation does not start.
  const initial = isolationNow();
  if (mode === "production" && !initial.verified) {
    throw new ServiceError("ISOLATION_UNAVAILABLE", `refusing to start in production: ${initial.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`, { checks: initial.checks });
  }

  const audit = createAudit(join(dirs.audit, "chain.jsonl"));
  const privatePath = join(dirs.trusted, "private.pem");
  const publicPath = join(dirs.trusted, "public.pem");
  if (!existsSync(privatePath)) {
    const pair = generateApprovalKeyPair();
    writeFileSync(privatePath, pair.privateKeyPem, { mode: 0o600 });
    writeFileSync(publicPath, pair.publicKeyPem, { mode: 0o644 });
    audit.append("key-generated", {});
  }
  const startedAt = Date.now();

  // Restart recovery: anything that was mid-execution when the process stopped is unknown, never assumed done or undone.
  for (const file of readdirSync(dirs.ledger).filter((f) => f.endsWith(".json"))) {
    const id = file.slice(0, -5);
    const entry = readLedgerEntry(dirs.ledger, id);
    if (entry?.status === "started") {
      failLedgerEntry(dirs.ledger, id, entry.requestFingerprint, "the service stopped while this operation was executing; verify the repository before asking again", "requires_reconciliation");
      audit.append("recovered-in-flight", { consumptionId: id });
    }
  }

  const providers = createProviders({ stateDir: state, config, fetchImpl });
  const executor = createExecutor({ config, paths, providers });

  const pendingPath = (id) => join(dirs.shared, "pending", `${id}.json`);
  const approvedPath = (id) => join(dirs.shared, "approved", `${id}.json`);
  const rejectedPath = (id) => join(dirs.shared, "rejected", `${id}.json`);
  const tokenPath = (id) => join(dirs.shared, "authorizations", `${id}.token`);
  const requestPath = (id) => join(dirs.requests, `${id}.json`);
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  };

  const publicKeyPem = () => {
    try {
      return readFileSync(publicPath, "utf8");
    } catch {
      throw new ServiceError("APPROVAL_ISOLATION_UNAVAILABLE", "the service's trust anchor (public key) is not readable; failing closed");
    }
  };

  // --- operator channel ---------------------------------------------------------------------------------------

  function signApproved(plan, approver, channel) {
    if (typeof channel !== "string" || !channel.startsWith("webauthn:")) throw new ServiceError("CHANNEL_REFUSED", "the service signs only a human-verified operator channel");
    const issued = now();
    const action = plan.actions[0];
    const content = action.content ?? "";
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
      action: action.action,
      targets: action.targets,
      decisionKind: plan.decisionKind,
      channel,
      content,
      contentDigest: approvedContentDigest(content),
      approver,
      issuedAt: issued.toISOString(),
      expiresAt: plan.expiresAt,
      consumptionId: `c-${sha256(`${plan.planId}:${randomUUID()}`).slice(0, 24)}`,
    };
    const token = encodeAuthorization(signAuthorization(body, readFileSync(privatePath, "utf8")));
    writeTokenOnce(tokenPath(plan.planId), token);
    if (existsSync(pendingPath(plan.planId))) renameSync(pendingPath(plan.planId), approvedPath(plan.planId));
    audit.append("approved", { planId: plan.planId, fingerprint: plan.fingerprint, approver, channel, consumptionId: body.consumptionId });
    return { ok: true, planId: plan.planId, consumptionId: body.consumptionId, channel };
  }

  function rejectPlan(plan, approver, channel) {
    if (existsSync(pendingPath(plan.planId))) renameSync(pendingPath(plan.planId), rejectedPath(plan.planId));
    audit.append("rejected", { planId: plan.planId, fingerprint: plan.fingerprint, approver, channel });
  }

  const enrollFile = join(dirs.trusted, "enroll.json");
  const readEnrollment = () => {
    const doc = readJson(enrollFile);
    return doc && Date.parse(doc.expiresAt) > Date.now() ? doc.code : undefined;
  };
  const operatorPort = config.operator?.port ?? 8780;
  const origin = config.operator?.origin ?? `http://localhost:${operatorPort}`;
  const web = createOperatorWeb({
    origin,
    trustedDir: dirs.trusted,
    sharedDir: dirs.shared,
    contracts: { ActionPlanSchema, renderActionPlanForHuman },
    signApproved,
    rejectPlan,
    enrollSecret: readEnrollment,
    onEnrolled: () => {
      try {
        unlinkSync(enrollFile);
      } catch {
        /* already closed */
      }
      audit.append("operator-enrolled", {});
    },
  });

  // --- request handling ---------------------------------------------------------------------------------------

  const repoQueues = new Map();
  const serialize = (key, fn) => {
    const prev = repoQueues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    repoQueues.set(key, next);
    next.finally(() => repoQueues.get(key) === next && repoQueues.delete(key)).catch(() => undefined);
    return next;
  };

  const operatorUrl = (planId) => `${origin}/plan/${encodeURIComponent(planId)}`;

  function stateOf(planId) {
    const request = readJson(requestPath(planId));
    if (!request) throw new ServiceError("REQUEST_NOT_FOUND", "no such request");
    const out = { requestId: planId, operation: request.operation, workItemId: request.workItemId, repository: request.repository };
    const token = existsSync(tokenPath(planId)) ? readFileSync(tokenPath(planId), "utf8").trim() : undefined;
    if (token) {
      let body;
      try {
        body = verifyAuthorization(token, publicKeyPem(), now());
      } catch (error) {
        // An expired or invalid token cannot be used. Report expiry unless the operation already completed.
        const consumption = (() => {
          try {
            return JSON.parse(Buffer.from(token, "base64url").toString("utf8")).body.consumptionId;
          } catch {
            return undefined;
          }
        })();
        const entry = consumption ? readLedgerEntry(dirs.ledger, consumption) : undefined;
        if (entry?.status === "completed") return { ...out, state: "completed", result: entry.result };
        return { ...out, state: "expired", detail: error.message };
      }
      const entry = readLedgerEntry(dirs.ledger, body.consumptionId);
      if (!entry) return { ...out, state: "approved", approvedAt: body.issuedAt, approvalExpiresAt: body.expiresAt, channel: body.channel };
      if (entry.status === "completed") return { ...out, state: "completed", result: entry.result };
      if (entry.status === "started") return { ...out, state: "executing" };
      return { ...out, state: "failed", status: entry.status, detail: entry.error };
    }
    if (existsSync(rejectedPath(planId))) return { ...out, state: "rejected" };
    const plan = readJson(pendingPath(planId));
    if (!plan) return { ...out, state: "failed", detail: "the plan is not in the inbox" };
    if (Date.parse(plan.expiresAt) <= now().getTime()) return { ...out, state: "expired", expiresAt: plan.expiresAt };
    return { ...out, state: "awaiting-operator", operatorUrl: operatorUrl(planId), fingerprint: plan.fingerprint, expiresAt: plan.expiresAt };
  }

  async function submit(request) {
    const rq = { operation: request.operation, repository: request.repository, workItemId: request.workItemId, params: request.params };
    const { described, real } = await executor.describe(rq);
    const key = { operation: rq.operation, action: ACTIONS[rq.operation], repository: real, workItemId: rq.workItemId, previewFingerprint: described.previewFingerprint };
    const planId = gitPlanId(key);
    if (!existsSync(requestPath(planId))) {
      atomicWrite(requestPath(planId), `${JSON.stringify({ ...rq, repository: real, key, submittedAt: now().toISOString() }, null, 2)}\n`);
    }
    const existing = stateOf(planId);
    const retryable = existing.state === "expired";
    if (existing.state !== "awaiting-operator" && existing.state !== "failed" && !retryable) return { ...existing, resubmitted: true };
    if (existing.state === "failed" && existing.detail !== "the plan is not in the inbox") return { ...existing, resubmitted: true };
    const plan = buildGitPlan(key, described, now(), planTtlMs());
    const pending = readJson(pendingPath(planId));
    const keep = pending && Date.parse(pending.expiresAt) > now().getTime() && rebuildWithTimes(key, described, pending).fingerprint === pending.fingerprint;
    if (!keep) {
      atomicWrite(pendingPath(planId), `${JSON.stringify(plan, null, 2)}\n`);
      if (existsSync(tokenPath(planId)) === false && existsSync(approvedPath(planId))) unlinkSync(approvedPath(planId));
      audit.append("submitted", { planId, operation: rq.operation, repository: real, workItemId: rq.workItemId, fingerprint: plan.fingerprint, revision: described.revision });
    }
    return stateOf(planId);
  }

  /** "failed" only when the service knows nothing visible changed; anything uncertain is requires_reconciliation. */
  function failureStatus(error) {
    if (typeof error.details?.changed === "string" && error.details.changed.startsWith("nothing")) return "failed";
    if (error instanceof GitxError) {
      if (/^(REPOSITORY_|BRANCH_|REMOTE_|DETACHED_HEAD|NOTHING_STAGED|UNSUPPORTED_|PROVIDER_BLOCKED|PROVIDER_NOT_AUTHORIZED|PROVIDER_CREDENTIAL_MISSING)/.test(error.code)) return "failed";
      if (error.code === "GIT_FAILED" && ["commit-tree", "update-ref", "write-tree"].includes(error.details?.args0)) return "failed";
    }
    return "requires_reconciliation";
  }

  async function execute(request) {
    const planId = request.requestId;
    const stored = readJson(requestPath(planId));
    if (!stored) throw new ServiceError("REQUEST_NOT_FOUND", "no such request");
    // A production service whose isolation has drifted does not execute anything.
    if (mode === "production") {
      const probeNow = isolationNow();
      if (!probeNow.verified) throw new ServiceError("APPROVAL_ISOLATION_UNAVAILABLE", `isolation is no longer verified: ${probeNow.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`);
    }
    const token = existsSync(tokenPath(planId)) ? readFileSync(tokenPath(planId), "utf8").trim() : undefined;
    if (!token) {
      const current = stateOf(planId);
      throw new ServiceError(current.state === "rejected" ? "APPROVAL_REJECTED" : current.state === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_REQUIRED", `request is ${current.state}; nothing was changed`, { state: current.state, operatorUrl: current.operatorUrl });
    }
    const plan = (() => {
      const parsed = ActionPlanSchema.safeParse(readJson(approvedPath(planId)));
      return parsed.success ? parsed.data : undefined;
    })();
    if (!plan) throw new ServiceError("APPROVAL_REQUIRED", "a token exists but its approved plan is missing or invalid; refusing");
    let verified;
    try {
      verified = assertTokenBindsPlan({ token, plan, key: stored.key, publicKeyPem: publicKeyPem(), now: now() });
    } catch (error) {
      audit.append("refused", { planId, code: error.code ?? "APPROVAL_REQUIRED", message: error.message });
      throw error;
    }
    const { body, content } = verified;
    // The service's own rule, stricter than the shared one: only a human-verified WebAuthn assertion authorizes execution here.
    if (typeof body.channel !== "string" || !body.channel.startsWith("webauthn:")) {
      audit.append("refused", { planId, code: "APPROVAL_CHANNEL_REFUSED", channel: String(body.channel) });
      throw new ServiceError("APPROVAL_CHANNEL_REFUSED", "the approval was not made through the operator's WebAuthn channel; refusing");
    }
    const fingerprint = `sha256:${sha256(content)}`;

    return serialize(stored.repository, async () => {
      const prior = readLedgerEntry(dirs.ledger, body.consumptionId);
      if (prior?.status === "completed") return { requestId: planId, state: "completed", replayed: true, result: prior.result };
      if (prior) throw new ServiceError(prior.status === "started" ? "EXECUTION_IN_PROGRESS" : "APPROVAL_RECONCILIATION_REQUIRED", prior.status === "started" ? "this approval is being executed" : `this approval was consumed and ended as ${prior.status}: ${prior.error ?? "unknown"}. It cannot be used again; verify the repository and ask for a new approval.`, { status: prior.status });
      // The repository must still be exactly what the owner approved. Refused before the approval is consumed.
      const live = await executor.describe(stored);
      if (gitRequestContent(stored.key, live.described) !== content || live.real !== stored.key.repository) {
        audit.append("refused", { planId, code: "APPROVAL_SCOPE_MISMATCH", message: "repository changed after approval" });
        throw new ServiceError("APPROVAL_SCOPE_MISMATCH", "the repository is no longer in the state the owner approved; nothing was changed. Ask for a new approval.");
      }
      if (rebuildWithTimes(stored.key, live.described, plan).fingerprint !== plan.fingerprint) {
        audit.append("refused", { planId, code: "APPROVAL_SCOPE_MISMATCH", message: "plan wording differs" });
        throw new ServiceError("APPROVAL_SCOPE_MISMATCH", "the approved plan is not the plan this request produces; nothing was changed. Ask for a new approval.");
      }
      const reservation = reserveLedgerEntry(dirs.ledger, body.consumptionId, fingerprint);
      if (!reservation.created) {
        if (reservation.entry.status === "completed") return { requestId: planId, state: "completed", replayed: true, result: reservation.entry.result };
        throw new ServiceError("EXECUTION_IN_PROGRESS", "this approval is already being executed");
      }
      audit.append("execution-started", { planId, consumptionId: body.consumptionId, operation: stored.operation });
      try {
        const result = await executor.execute(stored, live.facts);
        completeLedgerEntry(dirs.ledger, body.consumptionId, fingerprint, result);
        audit.append("execution-completed", { planId, consumptionId: body.consumptionId, operation: stored.operation, result });
        return { requestId: planId, state: "completed", replayed: false, result };
      } catch (error) {
        const status = failureStatus(error);
        failLedgerEntry(dirs.ledger, body.consumptionId, fingerprint, error.message, status);
        audit.append("execution-failed", { planId, consumptionId: body.consumptionId, status, code: error.code, message: error.message });
        throw new ServiceError(error.code ?? "EXECUTION_FAILED", `${error.message}. The approval is consumed (${status}).`, { status, ...(error.details ?? {}), changed: error.details?.changed ?? (status === "failed" ? "nothing" : "unknown: verify the repository and remote"), rollback: error.details?.rollback ?? (status === "failed" ? "none needed" : "inspect, then request a new approval") });
      }
    });
  }

  function health() {
    const isolation = isolationNow();
    const operators = readJson(join(dirs.trusted, "operators.json"));
    const pending = readdirSync(join(dirs.shared, "pending")).filter((f) => f.endsWith(".json")).length;
    return {
      service: "praxis-approval-service",
      version,
      protocol: APPROVAL_SERVICE_PROTOCOL,
      mode,
      platform: platformId,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      isolation,
      operatorChannel: { url: origin, enrolledAuthenticators: operators?.credentials?.length ?? 0 },
      pending,
      auditChain: audit.verify(),
      ledgerEntries: readdirSync(dirs.ledger).filter((f) => f.endsWith(".json")).length,
    };
  }

  async function handle(raw) {
    const parsed = parseServiceRequest(raw);
    const base = { protocol: APPROVAL_SERVICE_PROTOCOL, ...(parsed.ok && parsed.request.id ? { id: parsed.request.id } : {}) };
    if (!parsed.ok) {
      audit.append("refused", { code: parsed.code, op: raw && typeof raw === "object" ? String(raw.op ?? "").slice(0, 40) : "?" });
      return { ok: false, ...base, code: parsed.code, message: parsed.message };
    }
    const request = parsed.request;
    try {
      if (request.op === "health") return { ok: true, ...base, health: health() };
      if (request.op === "submit") return { ok: true, ...base, ...(await submit(request)) };
      if (request.op === "status") return { ok: true, ...base, ...stateOf(request.requestId) };
      if (request.op === "execute") return { ok: true, ...base, ...(await execute(request)) };
    } catch (error) {
      const code = error.code ?? "SERVICE_ERROR";
      return { ok: false, ...base, code, message: error.message, ...(error.details ? { details: error.details } : {}) };
    }
    return { ok: false, ...base, code: "UNKNOWN_OPERATION", message: "unsupported" };
  }

  // --- IPC server -----------------------------------------------------------------------------------------------

  const ipc = createServer((socket) => {
    let buffer = "";
    let answered = false;
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (answered) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_MESSAGE_BYTES) {
        answered = true;
        socket.end(`${JSON.stringify({ ok: false, protocol: APPROVAL_SERVICE_PROTOCOL, code: "BAD_REQUEST", message: "message too large" })}\n`);
        return;
      }
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      answered = true;
      socket.setTimeout(0);
      let message;
      try {
        message = JSON.parse(buffer.slice(0, nl));
      } catch {
        socket.end(`${JSON.stringify({ ok: false, protocol: APPROVAL_SERVICE_PROTOCOL, code: "BAD_REQUEST", message: "not JSON" })}\n`);
        return;
      }
      handle(message).then((reply) => socket.end(`${JSON.stringify(reply)}\n`), (error) => socket.end(`${JSON.stringify({ ok: false, protocol: APPROVAL_SERVICE_PROTOCOL, code: "SERVICE_ERROR", message: String(error?.message ?? error) })}\n`));
    });
  });
  ipc.maxConnections = 128;

  async function listen() {
    if (process.platform !== "win32") {
      // A leftover socket file is removed only when nothing answers on it; a live instance is never displaced.
      if (existsSync(paths.endpoint)) {
        const alive = await new Promise((done) => {
          const probeSocket = createConnection(paths.endpoint);
          probeSocket.once("connect", () => (probeSocket.destroy(), done(true)));
          probeSocket.once("error", () => done(false));
        });
        if (alive) throw new ServiceError("ALREADY_RUNNING", "another approval service instance is answering on the endpoint");
        unlinkSync(paths.endpoint);
      }
      mkdirSync(resolve(paths.endpoint, ".."), { recursive: true, mode: 0o755 });
    }
    await new Promise((done, fail) => {
      ipc.once("error", fail);
      ipc.listen(paths.endpoint, () => done());
    });
    // The socket is reachable by every local user so the Runtime client can connect. That is safe by design: no message on it approves anything.
    if (process.platform !== "win32") chmodSync(paths.endpoint, 0o666);
    await new Promise((done, fail) => {
      web.server.once("error", fail);
      web.server.listen(operatorPort, "127.0.0.1", () => done());
    });
    audit.append("service-started", { version, mode, platform: platformId, isolationVerified: initial.verified });
  }

  async function close() {
    await new Promise((done) => ipc.close(() => done()));
    await new Promise((done) => web.server.close(() => done()));
    ipc.closeAllConnections?.();
    audit.append("service-stopped", {});
  }

  return { handle, listen, close, health, audit, dirs, web, paths, operatorPort: () => web.server.address()?.port };
}
