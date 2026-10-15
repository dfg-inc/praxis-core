import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { canonicalize } from "./approval.js";
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
};

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
}): void {
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
}

type LedgerEntry = { status: "completed" | "started"; result?: unknown };

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
  writeFileSync(ledgerFile(ledger, consumptionId), `${JSON.stringify(entry)}\n`);
}

export function storyConfirmationDigest(input: {
  storyId: string;
  revision: number;
  contentFingerprint: string;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex")}`;
}
