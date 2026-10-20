import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ApprovalOperation,
  type ApprovalPlan,
  ApprovalPlanSchema,
  authorizeOperation,
  proposePlan,
  revisePlan,
  storedPlanFingerprint,
} from "./approval.js";
import {
  assertSecureExecutor,
  authorizationMatches,
  completeLedgerEntry,
  executionRequestFingerprint,
  failLedgerEntry,
  reserveLedgerEntry,
  securityMode,
  verifyAuthorization,
} from "./broker.js";
import { decisionKindFor, type DecisionKind } from "./action-plan.js";
import { WorkflowError } from "./workflow.js";

export const APPROVAL_RECORD_CONTRACT = "praxis.approval.record";
export const APPROVAL_RECORD_VERSION = 1;

export type ConsumptionStatus = "started" | "completed" | "aborted";

export type Consumption = {
  key: string;
  action: string;
  status: ConsumptionStatus;
  at: string;
  result?: unknown;
};

export type ApprovalRecord = {
  recordContract: typeof APPROVAL_RECORD_CONTRACT;
  recordVersion: typeof APPROVAL_RECORD_VERSION;
  plan: ApprovalPlan;
  consumptions: Consumption[];
};

export type MutationRequest = {
  repo: string;
  planId?: string;
  planFingerprint?: string;
  operation: ApprovalOperation;
  provider: ApprovalPlan["provider"];
  instanceId?: string;
  workItemId?: string;
  repository?: string;
  previewFingerprint?: string;
  action: string;
  now?: Date;
  /** True when this process already marked the consumption started. */
  resumeInFlight?: boolean;
  /** Broker artifact. Required in secure mode. Ignored in compatibility mode. */
  authorization?: string;
  /** What kind of decision this write needs. Derived from operation and action when not given. */
  decisionKind?: DecisionKind;
};

export type MutationInspection =
  | { kind: "replay"; planId: string; key: string; result: unknown }
  | { kind: "ready"; planId: string; key: string }
  | { kind: "in_flight"; planId: string; key: string };

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function approvalsDir(repo: string): string {
  return join(resolve(repo), ".praxis", "approvals");
}

export function approvalPath(repo: string, planId: string): string {
  if (!PLAN_ID.test(planId)) {
    throw new WorkflowError("APPROVAL_REQUIRED", "plan id is not a persisted approval name");
  }
  return join(approvalsDir(repo), `${planId}.json`);
}

function emptyRecord(plan: ApprovalPlan): ApprovalRecord {
  return {
    recordContract: APPROVAL_RECORD_CONTRACT,
    recordVersion: APPROVAL_RECORD_VERSION,
    plan,
    consumptions: [],
  };
}

function parseRecord(raw: unknown): ApprovalRecord {
  if (!raw || typeof raw !== "object") {
    throw new WorkflowError("APPROVAL_REQUIRED", "approval record is unreadable");
  }
  const record = raw as Partial<ApprovalRecord>;
  if (record.recordContract !== APPROVAL_RECORD_CONTRACT || record.recordVersion !== APPROVAL_RECORD_VERSION) {
    throw new WorkflowError("APPROVAL_REQUIRED", "approval record version is not supported");
  }
  const plan = ApprovalPlanSchema.parse(record.plan);
  const consumptions = Array.isArray(record.consumptions) ? record.consumptions : [];
  return { recordContract: APPROVAL_RECORD_CONTRACT, recordVersion: APPROVAL_RECORD_VERSION, plan, consumptions };
}

export function readApproval(repo: string, planId: string): ApprovalRecord {
  try {
    return parseRecord(JSON.parse(readFileSync(approvalPath(repo, planId), "utf8")));
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("APPROVAL_REQUIRED", `no stored approval ${planId}`);
  }
}

function writeRecord(repo: string, record: ApprovalRecord): void {
  const dir = approvalsDir(repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(approvalPath(repo, record.plan.planId), `${JSON.stringify(record, null, 2)}\n`);
}

export function listApprovals(repo: string): ApprovalRecord[] {
  let names: string[] = [];
  try {
    names = readdirSync(approvalsDir(repo));
  } catch {
    return [];
  }
  const records: ApprovalRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      records.push(readApproval(repo, name.slice(0, -".json".length)));
    } catch {
      continue;
    }
  }
  return records;
}

/** Persist a proposal. Refuses to store an already approved plan. */
export function saveProposal(repo: string, plan: ApprovalPlan): ApprovalRecord {
  if (plan.state === "APPROVED" || plan.state === "EXECUTING" || plan.state === "REVOKED") {
    throw new WorkflowError("APPROVAL_SELF_GRANT_FORBIDDEN", "a proposal cannot be stored as an authorization");
  }
  if (plan.fingerprint !== storedPlanFingerprint(plan)) {
    throw new WorkflowError("APPROVAL_FINGERPRINT_MISMATCH", "proposal fingerprint does not match its body");
  }
  const record = emptyRecord(plan);
  writeRecord(repo, record);
  return record;
}

/**
 * Record that the host permission step completed for this exact fingerprint.
 * Not an MCP tool and not proof against a same-user process that can write the file.
 */
export function commitHostApproval(repo: string, planId: string, fingerprint: string, now = new Date(), ttlMs = 12 * 60 * 60 * 1000): ApprovalPlan {
  const record = readApproval(repo, planId);
  if (record.plan.state !== "AWAITING_APPROVAL") {
    throw new WorkflowError("APPROVAL_TRANSITION_FORBIDDEN", `host commit refused from ${record.plan.state}`);
  }
  if (record.plan.fingerprint !== fingerprint) {
    throw new WorkflowError("APPROVAL_FINGERPRINT_MISMATCH", "host commit fingerprint does not match the stored proposal");
  }
  const approved: ApprovalPlan = {
    ...record.plan,
    state: "APPROVED",
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  writeRecord(repo, { ...record, plan: approved });
  return approved;
}

export function rejectStoredApproval(repo: string, planId: string): ApprovalPlan {
  const record = readApproval(repo, planId);
  if (record.plan.state !== "AWAITING_APPROVAL") {
    throw new WorkflowError("APPROVAL_TRANSITION_FORBIDDEN", `reject refused from ${record.plan.state}`);
  }
  const plan: ApprovalPlan = { ...record.plan, state: "REJECTED" };
  writeRecord(repo, { ...record, plan, consumptions: [] });
  return plan;
}

export function revokeStoredApproval(repo: string, planId: string): ApprovalPlan {
  const record = readApproval(repo, planId);
  if (record.plan.state !== "APPROVED" && record.plan.state !== "EXECUTING") {
    throw new WorkflowError("APPROVAL_TRANSITION_FORBIDDEN", `revoke refused from ${record.plan.state}`);
  }
  const plan: ApprovalPlan = { ...record.plan, state: "REVOKED" };
  writeRecord(repo, { ...record, plan });
  return plan;
}

export function reviseStoredApproval(
  repo: string,
  planId: string,
  patch: Parameters<typeof revisePlan>[1],
): ApprovalPlan {
  const record = readApproval(repo, planId);
  const plan = revisePlan(record.plan, patch);
  writeRecord(repo, emptyRecord(plan));
  return plan;
}

export function installHostApproval(
  repo: string,
  input: Parameters<typeof proposePlan>[0] & { now?: Date; ttlMs?: number },
): ApprovalPlan {
  const { now, ttlMs, ...body } = input;
  const proposed = proposePlan(body);
  saveProposal(repo, proposed);
  return commitHostApproval(repo, proposed.planId, proposed.fingerprint, now, ttlMs);
}

function consumptionKey(plan: ApprovalPlan, request: MutationRequest): string {
  return createHash("sha256").update([
    plan.planId,
    String(plan.version),
    plan.fingerprint,
    request.action,
    request.operation,
    request.workItemId ?? "",
    request.repository ?? "",
    request.previewFingerprint ?? "",
  ].join("\n")).digest("hex");
}

function selectRecord(request: MutationRequest, now: Date): ApprovalRecord {
  if (request.planId) {
    const record = readApproval(request.repo, request.planId);
    if (request.planFingerprint && request.planFingerprint !== record.plan.fingerprint) {
      throw new WorkflowError("APPROVAL_FINGERPRINT_MISMATCH", "plan fingerprint does not match the stored approval");
    }
    return record;
  }
  const matches = listApprovals(request.repo).filter((record) => {
    try {
      authorizeBound(record.plan, request, now);
      return true;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new WorkflowError(
      matches.length === 0 ? "APPROVAL_REQUIRED" : "APPROVAL_AMBIGUOUS",
      matches.length === 0 ? "no stored approval matches this operation" : "more than one stored approval matches this operation",
    );
  }
  return matches[0]!;
}

function authorizeBound(plan: ApprovalPlan, request: MutationRequest, now: Date): void {
  if (request.provider === "jira" && !request.instanceId) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "external instance is required");
  }
  authorizeOperation(plan, request.operation, {
    workItemId: request.workItemId,
    repository: request.repository,
    provider: request.provider,
    instanceId: request.instanceId,
    previewFingerprint: request.previewFingerprint,
  }, now);
  if (!plan.inScope.includes(request.action)) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", `${request.action} is outside plan ${plan.planId}`);
  }
}

export function inspectMutation(request: MutationRequest): MutationInspection {
  const now = request.now ?? new Date();
  const record = selectRecord(request, now);
  authorizeBound(record.plan, request, now);
  const key = consumptionKey(record.plan, request);
  const prior = record.consumptions.find((item) => item.key === key);
  if (prior?.status === "completed") {
    return { kind: "replay", planId: record.plan.planId, key, result: prior.result };
  }
  if (prior?.status === "started" && request.resumeInFlight) {
    return { kind: "in_flight", planId: record.plan.planId, key };
  }
  if (prior?.status === "started" || prior?.status === "aborted") {
    throw new WorkflowError("APPROVAL_RECONCILIATION_REQUIRED", `${request.action} already started and must not run again`);
  }
  return { kind: "ready", planId: record.plan.planId, key };
}

function updateConsumption(repo: string, planId: string, key: string, status: ConsumptionStatus, action: string, result?: unknown): void {
  const record = readApproval(repo, planId);
  const existing = record.consumptions.find((item) => item.key === key);
  const next: Consumption = {
    key,
    action,
    status,
    at: new Date().toISOString(),
    ...(result !== undefined ? { result } : {}),
  };
  const consumptions = existing
    ? record.consumptions.map((item) => (item.key === key ? next : item))
    : [...record.consumptions, next];
  writeRecord(repo, { ...record, consumptions });
}

export function beginConsumption(repo: string, planId: string, key: string, action: string): void {
  updateConsumption(repo, planId, key, "started", action);
}

export function completeConsumption(repo: string, planId: string, key: string, action: string, result: unknown): void {
  updateConsumption(repo, planId, key, "completed", action, result);
}

export function abortConsumption(repo: string, planId: string, key: string, action: string): void {
  updateConsumption(repo, planId, key, "aborted", action);
}

const mutationLease = new AsyncLocalStorage<{ action: string }>();

export function hasMutationLease(): boolean {
  return mutationLease.getStore() !== undefined;
}

/** Lowest-level writers call this. A direct call outside an authorized mutation throws before any write. */
export function requireMutationLease(): void {
  if (!mutationLease.getStore()) {
    throw new WorkflowError("APPROVAL_REQUIRED", "direct mutation is not authorized");
  }
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value) && typeof (value as Promise<T>).then === "function";
}

/**
 * Checks the persisted plan, then runs the write inside a lease.
 * Nested product functions see the lease and do not open a second consumption.
 * A completed consumption returns the stored result and does not write again.
 */
function runSecureMutation<T>(request: MutationRequest, write: () => T): T {
  const { ledger, publicKeyPem } = assertSecureExecutor(request.repo);
  const authorization = request.authorization ?? process.env.PRAXIS_APPROVAL_AUTHORIZATION?.trim();
  if (!authorization) {
    throw new WorkflowError("APPROVAL_REQUIRED", "secure mode requires a broker authorization for this plan");
  }
  const body = verifyAuthorization(authorization, publicKeyPem, request.now);
  if (!request.planFingerprint) {
    throw new WorkflowError("APPROVAL_REQUIRED", "plan fingerprint is required for secure execution");
  }
  if (!request.instanceId) {
    throw new WorkflowError("APPROVAL_REQUIRED", "provider instance is required for secure execution");
  }
  authorizationMatches(body, {
    planFingerprint: request.planFingerprint,
    provider: request.provider,
    instanceId: request.instanceId,
    operation: request.operation,
    action: request.action,
    workItemId: request.workItemId,
    repository: request.repository,
    planId: request.planId,
    targets: body.targets,
    contentDigest: body.contentDigest,
    decisionKind: decisionKindFor(request.operation, request.action, request.decisionKind),
  });
  const requestFingerprint = executionRequestFingerprint({
    consumptionId: body.consumptionId,
    planId: body.planId ?? request.planId ?? "",
    planFingerprint: request.planFingerprint,
    provider: request.provider,
    instanceId: request.instanceId,
    operation: request.operation,
    action: request.action,
    workItemId: request.workItemId ?? "",
    repository: request.repository ?? request.repo,
    targets: body.targets ?? [],
    contentDigest: body.contentDigest ?? "",
  });
  const reserved = reserveLedgerEntry(ledger, body.consumptionId, requestFingerprint);
  if (!reserved.created) {
    if (reserved.entry.requestFingerprint && reserved.entry.requestFingerprint !== requestFingerprint) {
      throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "authorization replay is bound to a different execution request");
    }
    if (reserved.entry.status === "completed") return reserved.entry.result as T;
    if (reserved.entry.status === "started") {
      throw new WorkflowError("APPROVAL_RECONCILIATION_REQUIRED", "authorization consumption is already in progress");
    }
    throw new WorkflowError(
      "APPROVAL_RECONCILIATION_REQUIRED",
      `authorization consumption is ${reserved.entry.status}; refuse uncontrolled retry`,
    );
  }
  const finish = (result: T): T => {
    completeLedgerEntry(ledger, body.consumptionId, requestFingerprint, result);
    return result;
  };
  const fail = (error: unknown): never => {
    failLedgerEntry(
      ledger,
      body.consumptionId,
      requestFingerprint,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  };
  try {
    const result = mutationLease.run({ action: request.action }, write);
    if (isPromise(result)) return result.then(finish, fail) as T;
    return finish(result);
  } catch (error) {
    return fail(error);
  }
}

export function runAuthorizedMutation<T>(request: MutationRequest, write: () => T): T {
  if (securityMode() === "secure") return runSecureMutation(request, write);
  const inspection = inspectMutation({ ...request, resumeInFlight: true });
  if (inspection.kind === "replay") return inspection.result as T;
  const owner = inspection.kind === "ready";
  if (owner) beginConsumption(request.repo, inspection.planId, inspection.key, request.action);
  const finish = (result: T): T => {
    if (owner) completeConsumption(request.repo, inspection.planId, inspection.key, request.action, result);
    return result;
  };
  const fail = (error: unknown): never => {
    if (owner) {
      try {
        abortConsumption(request.repo, inspection.planId, inspection.key, request.action);
      } catch {
        /* keep the write error */
      }
    }
    throw error;
  };
  try {
    const result = mutationLease.run({ action: request.action }, write);
    if (isPromise(result)) return result.then(finish, fail) as T;
    return finish(result);
  } catch (error) {
    return fail(error);
  }
}
