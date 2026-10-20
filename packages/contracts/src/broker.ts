import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { canonicalize } from "./approval.js";
import { assertApprovalChannelAcceptable, assertSecureDeploymentAssessment, assessApprovalDeployment, productionBuild, testIdentityOverrideActive } from "./deployment.js";
import { decisionKindFor, DecisionKindSchema } from "./authority.js";
import { WorkflowError } from "./workflow.js";

/**
 * Secure mode refuses protected mutations unless a separate broker signed the
 * exact plan and this process cannot read the signing key. A JSON approval
 * file is not accepted. Compatibility mode is explicit and is not a
 * production boundary against a same-user agent.
 */

export const AUTHORIZATION_CONTRACT = "praxis.approval.authorization";
export const AUTHORIZATION_VERSION = 1;

export type SecurityMode = "secure" | "compatibility";

export type AuthorizationBody = {
  contract: typeof AUTHORIZATION_CONTRACT;
  version: typeof AUTHORIZATION_VERSION;
  planFingerprint: string;
  provider: string;
  instanceId: string;
  operations: string[];
  workItemIds: string[];
  repositories: string[];
  action: string;
  approver: string;
  issuedAt: string;
  expiresAt: string;
  consumptionId: string;
  /** Bound plan identity. Required for executor fixture writes. */
  planId?: string;
  /** Exact approved targets. Required for executor fixture writes. */
  targets?: string[];
  /** Exact approved file contents for fixture writes. */
  content?: string;
  /** sha256 digest of approved content. */
  contentDigest?: string;
  /** The kind of decision approved (requirement, architecture, story, development, quality, git, tracker). */
  decisionKind?: string;
  /**
   * How the owner decided, signed into the token by the broker: "webauthn:<credential>" (operator page with an
   * authenticator), "operator-socket" (operator console), or "machine" (automation/test). A production build
   * accepts only the first two, so a machine-issued token cannot pass for a person's approval.
   */
  channel?: string;
};


export type ExecutionRequest = {
  consumptionId: string;
  planId: string;
  planFingerprint: string;
  provider: string;
  instanceId: string;
  operation: string;
  action: string;
  workItemId: string;
  repository: string;
  targets: string[];
  contentDigest: string;
};

export const EXECUTION_PAYLOAD_KEYS = [
  "planId",
  "planFingerprint",
  "provider",
  "instanceId",
  "operation",
  "action",
  "workItemId",
  "repository",
  "targets",
  "contentDigest",
] as const;

export function approvedContentDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function executionRequestFingerprint(request: ExecutionRequest): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(request))).digest("hex")}`;
}

export type SignedAuthorization = {
  body: AuthorizationBody;
  signature: string;
};

export function securityMode(): SecurityMode {
  const raw = process.env.PRAXIS_SECURITY_MODE?.trim() ?? "";
  if (raw === "compatibility") return "compatibility";
  if (raw === "secure" || raw === "") return "secure";
  throw new WorkflowError("APPROVAL_REQUIRED", "PRAXIS_SECURITY_MODE must be secure or compatibility");
}

export function canonicalAuthorizationBytes(body: AuthorizationBody): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(body)));
}

export function generateApprovalKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signAuthorization(body: AuthorizationBody, privateKeyPem: string): SignedAuthorization {
  const signature = sign(null, canonicalAuthorizationBytes(body), createPrivateKey(privateKeyPem)).toString("base64");
  return { body, signature };
}

export function encodeAuthorization(signed: SignedAuthorization): string {
  return Buffer.from(JSON.stringify(signed)).toString("base64url");
}

export function decodeAuthorization(token: string): SignedAuthorization {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new WorkflowError("APPROVAL_REQUIRED", "authorization artifact is malformed");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new WorkflowError("APPROVAL_REQUIRED", "authorization artifact is malformed");
  }
  const signature = (parsed as { signature?: unknown }).signature;
  const body = (parsed as { body?: unknown }).body;
  if (typeof signature !== "string" || !body || typeof body !== "object") {
    throw new WorkflowError("APPROVAL_REQUIRED", "authorization artifact is malformed");
  }
  return { body: body as AuthorizationBody, signature };
}

export function signingKeyVisibleToThisProcess(): boolean {
  if (process.env.PRAXIS_APPROVAL_PRIVATE_KEY?.trim()) return true;
  const keyPath = process.env.PRAXIS_APPROVAL_PRIVATE_KEY_PATH?.trim();
  if (!keyPath) return false;
  try {
    accessSync(keyPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function assertSigningKeyHidden(): void {
  if (signingKeyVisibleToThisProcess()) {
    throw new WorkflowError(
      "APPROVAL_ISOLATION_UNAVAILABLE",
      "approval signing key is visible to this process; secure mode refuses",
    );
  }
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export type DeploymentThreatAssessment = {
  mode: SecurityMode;
  dockerSocketAccessible: boolean;
  signingKeyVisible: boolean;
  blocking: string[];
  warnings: string[];
};

/** Threat model for the Docker UID isolation deployment. */
export function assessDeploymentThreats(opts?: { dockerSockets?: string[] }): DeploymentThreatAssessment {
  const mode = securityMode();
  const sockets = opts?.dockerSockets ?? [
    "/var/run/docker.sock",
    `${process.env.HOME ?? ""}/.docker/run/docker.sock`,
  ].filter(Boolean);
  let dockerSocketAccessible = false;
  for (const socket of sockets) {
    try {
      accessSync(socket, constants.R_OK | constants.W_OK);
      dockerSocketAccessible = true;
      break;
    } catch {
      /* closed */
    }
  }
  const signingKeyVisible = signingKeyVisibleToThisProcess();
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (mode === "compatibility") {
    warnings.push("compatibility mode trusts forgeable local approval files against same-user agents");
  }
  if (mode === "secure" && signingKeyVisible) {
    blocking.push("approval signing key is visible to this process");
  }
  const deploymentModel = process.env.PRAXIS_DEPLOYMENT_MODEL?.trim() ?? "";
  if (
    mode === "secure" &&
    deploymentModel === "docker-uid" &&
    dockerSocketAccessible &&
    process.env.PRAXIS_ALLOW_DOCKER_SOCKET !== "1"
  ) {
    blocking.push(
      "Docker control socket is accessible to this process; the agent can attach trusted volumes and defeat UID isolation",
    );
  } else if (mode === "secure" && dockerSocketAccessible) {
    warnings.push(
      "Docker socket is visible; set PRAXIS_DEPLOYMENT_MODEL=docker-uid to fail closed when using UID isolation",
    );
  }
  return { mode, dockerSocketAccessible, signingKeyVisible, blocking, warnings };
}

export function assertSecureDeployment(): DeploymentThreatAssessment {
  const assessment = assessDeploymentThreats();
  if (assessment.blocking.length) {
    throw new WorkflowError("APPROVAL_ISOLATION_UNAVAILABLE", assessment.blocking.join("; "));
  }
  return assessment;
}

export function assertSecureExecutor(repo: string): { ledger: string; publicKeyPem: string } {
  assertSecureDeployment();
  assertSigningKeyHidden();
  // Fail closed on a host where the agent identity can reach the trust chain: reporting it is not enough.
  // PRAXIS_TEST_ALLOW_SAME_IDENTITY=1 exists for automated tests that run broker and agent as one user; the
  // assessment still reports that host as unisolated and it is refused as a dotenv-supplied value.
  if (!testIdentityOverrideActive()) {
    assertSecureDeploymentAssessment(assessApprovalDeployment({ workspace: repo }));
  }
  const publicKeyPem =
    process.env.PRAXIS_APPROVAL_PUBLIC_KEY?.trim() ||
    (process.env.PRAXIS_APPROVAL_PUBLIC_KEY_PATH
      ? readFileSync(process.env.PRAXIS_APPROVAL_PUBLIC_KEY_PATH, "utf8")
      : undefined);
  const ledger = process.env.PRAXIS_APPROVAL_LEDGER?.trim();
  if (!publicKeyPem || !ledger) {
    throw new WorkflowError(
      "APPROVAL_ISOLATION_UNAVAILABLE",
      "secure mode requires PRAXIS_APPROVAL_PUBLIC_KEY (or PATH) and PRAXIS_APPROVAL_LEDGER outside the workspace",
    );
  }
  if (pathInside(repo, ledger)) {
    throw new WorkflowError(
      "APPROVAL_ISOLATION_UNAVAILABLE",
      "approval ledger is inside the agent workspace",
    );
  }
  return { ledger: resolve(ledger), publicKeyPem };
}

export function verifyAuthorization(token: string, publicKeyPem: string, now = new Date()): AuthorizationBody {
  const signed = decodeAuthorization(token);
  const body = signed.body;
  if (body.contract !== AUTHORIZATION_CONTRACT || body.version !== AUTHORIZATION_VERSION) {
    throw new WorkflowError("APPROVAL_REQUIRED", "authorization contract is not accepted");
  }
  const ok = verify(
    null,
    canonicalAuthorizationBytes(body),
    createPublicKey(publicKeyPem),
    Buffer.from(signed.signature, "base64"),
  );
  if (!ok) throw new WorkflowError("APPROVAL_REQUIRED", "authorization signature is not valid");
  const expires = Date.parse(body.expiresAt);
  const issued = Date.parse(body.issuedAt);
  if (!Number.isFinite(expires) || !Number.isFinite(issued) || now.getTime() > expires || issued > expires) {
    throw new WorkflowError("APPROVAL_EXPIRED", "authorization has expired");
  }
  return body;
}

export function authorizationMatches(body: AuthorizationBody, target: {
  planFingerprint: string;
  provider: string;
  instanceId?: string;
  operation: string;
  action: string;
  workItemId?: string;
  repository?: string;
  planId?: string;
  targets?: string[];
  contentDigest?: string;
  decisionKind?: string;
}): void {
  if (body.decisionKind !== undefined && body.decisionKind !== target.decisionKind) {
    throw new WorkflowError(
      "APPROVAL_SCOPE_SEPARATE",
      `this approval is for ${body.decisionKind}, not ${target.decisionKind ?? "an unstated kind of decision"}; one kind of approval never authorizes another`,
    );
  }
  if (body.planFingerprint !== target.planFingerprint) {
    throw new WorkflowError("APPROVAL_FINGERPRINT_MISMATCH", "plan fingerprint is not the approved revision");
  }
  if (body.provider !== target.provider) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "provider is not the approved provider");
  }
  if (target.instanceId !== undefined && body.instanceId !== target.instanceId) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "provider instance is not the approved instance");
  }
  if (!body.operations.includes(target.operation)) {
    throw new WorkflowError("APPROVAL_SCOPE_SEPARATE", "operation is outside the approved scope");
  }
  if (body.action !== target.action) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "action is outside the approved scope");
  }
  if (target.workItemId !== undefined && !body.workItemIds.includes(target.workItemId)) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "work item is outside the approved scope");
  }
  if (target.repository !== undefined && !body.repositories.includes(target.repository)) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "repository is outside the approved scope");
  }
  if (body.planId !== undefined && target.planId !== undefined && body.planId !== target.planId) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "plan id is not the approved plan");
  }
  if (body.targets !== undefined && target.targets !== undefined) {
    if (JSON.stringify(body.targets) !== JSON.stringify(target.targets)) {
      throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "targets are not the approved resources");
    }
  }
  if (body.contentDigest !== undefined && target.contentDigest !== undefined && body.contentDigest !== target.contentDigest) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "content is not the approved change");
  }
}

export function assertExecutionPayload(payload: unknown, body: AuthorizationBody, action: string): ExecutionRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WorkflowError("APPROVAL_REQUIRED", "execution payload is required");
  }
  const rec = payload as Record<string, unknown>;
  const extra = Object.keys(rec).filter(
    (key) => !(EXECUTION_PAYLOAD_KEYS as readonly string[]).includes(key) && key !== "decisionKind",
  );
  if (extra.length) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", `unauthorized payload fields: ${extra.join(",")}`);
  }
  for (const key of EXECUTION_PAYLOAD_KEYS) {
    if (rec[key] === undefined) {
      throw new WorkflowError("APPROVAL_REQUIRED", `missing mandatory execution field ${key}`);
    }
  }
  if (typeof rec.planId !== "string" || typeof rec.planFingerprint !== "string") {
    throw new WorkflowError("APPROVAL_REQUIRED", "plan identity fields are required");
  }
  if (typeof rec.provider !== "string" || typeof rec.instanceId !== "string") {
    throw new WorkflowError("APPROVAL_REQUIRED", "provider fields are required");
  }
  if (typeof rec.operation !== "string" || typeof rec.action !== "string") {
    throw new WorkflowError("APPROVAL_REQUIRED", "operation fields are required");
  }
  if (typeof rec.workItemId !== "string" || typeof rec.repository !== "string") {
    throw new WorkflowError("APPROVAL_REQUIRED", "work item and repository are required");
  }
  if (!Array.isArray(rec.targets) || rec.targets.some((item) => typeof item !== "string")) {
    throw new WorkflowError("APPROVAL_REQUIRED", "targets must be a string array");
  }
  if (typeof rec.contentDigest !== "string") {
    throw new WorkflowError("APPROVAL_REQUIRED", "contentDigest is required");
  }
  if (rec.action !== action) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "payload action does not match execute --action");
  }
  if (!body.planId || !body.targets || body.contentDigest === undefined) {
    throw new WorkflowError(
      "APPROVAL_REQUIRED",
      "authorization is not bound to plan id, targets, and content; refuse execution",
    );
  }
  authorizationMatches(body, {
    planId: rec.planId,
    planFingerprint: rec.planFingerprint,
    provider: rec.provider,
    instanceId: rec.instanceId,
    operation: rec.operation,
    action: rec.action,
    workItemId: rec.workItemId,
    repository: rec.repository,
    targets: rec.targets,
    contentDigest: rec.contentDigest,
    decisionKind: decisionKindFor(
      rec.operation,
      rec.action,
      rec.decisionKind === undefined ? undefined : DecisionKindSchema.parse(rec.decisionKind),
    ),
  });
  if (body.content !== undefined && approvedContentDigest(body.content) !== body.contentDigest) {
    throw new WorkflowError("APPROVAL_REQUIRED", "authorization content digest does not match bound content");
  }
  return {
    consumptionId: body.consumptionId,
    planId: rec.planId,
    planFingerprint: rec.planFingerprint,
    provider: rec.provider,
    instanceId: rec.instanceId,
    operation: rec.operation,
    action: rec.action,
    workItemId: rec.workItemId,
    repository: rec.repository,
    targets: rec.targets,
    contentDigest: rec.contentDigest,
  };
}

export type LedgerStatus = "started" | "completed" | "failed" | "requires_reconciliation";

export type LedgerEntry = {
  status: LedgerStatus;
  requestFingerprint: string;
  result?: unknown;
  error?: string;
};

function ledgerFile(ledger: string, consumptionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(consumptionId)) {
    throw new WorkflowError("APPROVAL_REQUIRED", "consumption id is not accepted");
  }
  return resolve(ledger, `${consumptionId}.json`);
}

export function readLedgerEntry(ledger: string, consumptionId: string): LedgerEntry | undefined {
  try {
    return JSON.parse(readFileSync(ledgerFile(ledger, consumptionId), "utf8")) as LedgerEntry;
  } catch {
    return undefined;
  }
}

export function writeLedgerEntry(ledger: string, consumptionId: string, entry: LedgerEntry): void {
  mkdirSync(ledger, { recursive: true });
  const dest = ledgerFile(ledger, consumptionId);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry)}\n`);
  renameSync(tmp, dest);
}

/** Atomically create a started ledger row. Concurrent callers lose the reservation. */
export function reserveLedgerEntry(
  ledger: string,
  consumptionId: string,
  requestFingerprint: string,
): { created: boolean; entry: LedgerEntry } {
  mkdirSync(ledger, { recursive: true });
  const dest = ledgerFile(ledger, consumptionId);
  const entry: LedgerEntry = { status: "started", requestFingerprint };
  try {
    const fd = openSync(dest, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
    } finally {
      closeSync(fd);
    }
    return { created: true, entry };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readLedgerEntry(ledger, consumptionId);
      if (!existing) {
        throw new WorkflowError("APPROVAL_RECONCILIATION_REQUIRED", "ledger reservation conflict");
      }
      return { created: false, entry: existing };
    }
    throw error;
  }
}

export function completeLedgerEntry(
  ledger: string,
  consumptionId: string,
  requestFingerprint: string,
  result: unknown,
): void {
  writeLedgerEntry(ledger, consumptionId, { status: "completed", requestFingerprint, result });
}

export function failLedgerEntry(
  ledger: string,
  consumptionId: string,
  requestFingerprint: string,
  error: string,
  status: Extract<LedgerStatus, "failed" | "requires_reconciliation"> = "failed",
): void {
  writeLedgerEntry(ledger, consumptionId, { status, requestFingerprint, error });
}

export function storyConfirmationDigest(input: {
  storyId: string;
  revision: number;
  contentFingerprint: string;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex")}`;
}
