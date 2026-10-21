import { createConnection } from "node:net";
import { accessSync, constants, statSync } from "node:fs";
import { dirname } from "node:path";
import { platform as osPlatform } from "node:os";
import { z } from "zod";

/**
 * Wire contract between the Praxis Runtime (the agent's side) and the Approval Service (a separate OS principal).
 *
 * The agent side may do three things: submit a request, read its status, and ask the service to execute a request
 * that a human has already approved. There is no message that approves, rejects, signs, changes a plan or touches a
 * credential: a request that is not one of the strict schemas below is refused as an unknown operation, so a new
 * privileged capability cannot appear by accident. Approval exists only on the operator channel (WebAuthn page).
 */

export const APPROVAL_SERVICE_PROTOCOL = "praxis.approval-service.v1";
export const SERVICE_OPERATIONS = ["git_commit", "git_push", "merge_request"] as const;
export type ServiceOperation = (typeof SERVICE_OPERATIONS)[number];
export const MAX_MESSAGE_BYTES = 64 * 1024;

const RepoPath = z.string().min(1).max(4096);
const Ref = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._\/-]+$/, "unsupported characters in a ref name")
  .refine((ref) => !ref.startsWith("-") && !ref.startsWith("/") && !ref.endsWith("/") && !ref.endsWith(".lock") && !ref.endsWith(".") && !ref.includes("..") && !ref.includes("//") && !ref.includes("@{"), "not a valid branch name");
const RelPath = z.string().min(1).max(1024);
const RemoteName = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).refine((n) => !["__proto__", "constructor", "prototype"].includes(n), "reserved name");
const WorkItem = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/, "work item ids use letters, digits and . _ : / -");

const CommitParams = z.object({ message: z.string().min(1).max(8000), branch: Ref.optional(), paths: z.array(RelPath).min(1).max(500).optional() }).strict();
const PushParams = z.object({ remote: RemoteName, branch: Ref }).strict();
const MergeRequestParams = z
  .object({
    remote: RemoteName,
    sourceBranch: Ref,
    targetBranch: Ref,
    title: z.string().min(1).max(300),
    body: z.string().max(8000).optional(),
  })
  .strict();

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const Common = {
  protocol: z.literal(APPROVAL_SERVICE_PROTOCOL),
  /**
   * Chosen by the caller, stable for one logical operation. The service binds it to the first request it was used for:
   * the same id returns that request's recorded state or result (even after the repository has moved on), and the same
   * id with different parameters is refused as a changed plan.
   */
  executionId: Id.optional(),
  /** Opaque correlation id echoed in the reply; never trusted for anything. */
  id: z.string().max(64).optional(),
};

export const SubmitRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...Common, op: z.literal("submit"), operation: z.literal("git_commit"), repository: RepoPath, workItemId: WorkItem, params: CommitParams }).strict(),
  z.object({ ...Common, op: z.literal("submit"), operation: z.literal("git_push"), repository: RepoPath, workItemId: WorkItem, params: PushParams }).strict(),
  z.object({ ...Common, op: z.literal("submit"), operation: z.literal("merge_request"), repository: RepoPath, workItemId: WorkItem, params: MergeRequestParams }).strict(),
]);
export const StatusRequestSchema = z
  .object({ ...Common, op: z.literal("status"), requestId: Id.optional() })
  .strict()
  .refine((r) => Boolean(r.requestId) !== Boolean(r.executionId), "give exactly one of requestId or executionId");
export const ExecuteRequestSchema = z.object({ ...Common, op: z.literal("execute"), requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/) }).strict();
export const HealthRequestSchema = z.object({ ...Common, op: z.literal("health") }).strict();

export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;
export type ServiceRequest = SubmitRequest | z.infer<typeof StatusRequestSchema> | z.infer<typeof ExecuteRequestSchema> | z.infer<typeof HealthRequestSchema>;

export type ServiceParseResult = { ok: true; request: ServiceRequest } | { ok: false; code: "UNKNOWN_OPERATION" | "BAD_REQUEST"; message: string };

/** Strict parse of one inbound message. Anything outside the four operations (approve, sign, set-config, ...) is UNKNOWN_OPERATION. */
export function parseServiceRequest(raw: unknown): ServiceParseResult {
  const op = raw && typeof raw === "object" ? (raw as { op?: unknown }).op : undefined;
  const schema =
    op === "submit" ? SubmitRequestSchema : op === "status" ? StatusRequestSchema : op === "execute" ? ExecuteRequestSchema : op === "health" ? HealthRequestSchema : undefined;
  if (!schema) return { ok: false, code: "UNKNOWN_OPERATION", message: "the approval service accepts only submit, status, execute and health; approval happens on the operator channel" };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "BAD_REQUEST", message: parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ") };
  return { ok: true, request: parsed.data as ServiceRequest };
}

export type RequestState = "awaiting-operator" | "approved" | "rejected" | "expired" | "executing" | "completed" | "failed";

export type ServiceReply =
  | { ok: true; protocol: typeof APPROVAL_SERVICE_PROTOCOL; id?: string; [key: string]: unknown }
  | { ok: false; protocol: typeof APPROVAL_SERVICE_PROTOCOL; id?: string; code: string; message: string; details?: Record<string, unknown> };

export type ServiceHealth = {
  service: "praxis-approval-service";
  version: string;
  protocol: typeof APPROVAL_SERVICE_PROTOCOL;
  /** "production" only for a service started with verified isolation; "development" is always unisolated. */
  mode: "production" | "development";
  platform: string;
  uptimeSec: number;
  isolation: { verified: boolean; principal: string; checks: { id: string; ok: boolean; detail: string }[] };
  operatorChannel: { url: string; enrolledAuthenticators: number };
  pending: number;
  auditChain: { ok: boolean; entries: number; head?: string | null };
  /** The chain and the ledger compared with their independent anchors. ok=false means truncation, rollback or a deleted sink. */
  integrity?: { ok: boolean; problems: string[]; anchored: number };
  ledgerEntries: number;
};

export function defaultServiceEndpoint(os: string = osPlatform()): string {
  if (os === "win32") return "\\\\.\\pipe\\praxis-approval-service";
  if (os === "darwin") return "/Library/Application Support/Praxis/ApprovalService/run/service.sock";
  return "/run/praxis-approval/service.sock";
}

export function serviceEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env.PRAXIS_APPROVAL_SERVICE_ENDPOINT?.trim() || defaultServiceEndpoint();
}

/** True when the Runtime should hand protected Git operations to the service: an endpoint is configured explicitly, or the platform default exists. */
export function serviceDelegationActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PRAXIS_APPROVAL_SERVICE_ENDPOINT?.trim()) return true;
  try {
    statSync(defaultServiceEndpoint());
    return true;
  } catch {
    return false;
  }
}

export class ApprovalServiceError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

/** One request, one reply, one connection. Rejects with ApprovalServiceError("SERVICE_UNAVAILABLE") when nothing answers. */
export function callApprovalService(message: Record<string, unknown>, opts: { endpoint?: string; timeoutMs?: number } = {}): Promise<ServiceReply> {
  const endpoint = opts.endpoint ?? serviceEndpoint();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new ApprovalServiceError("SERVICE_TIMEOUT", `the approval service did not answer within ${timeoutMs} ms`))), timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify({ protocol: APPROVAL_SERVICE_PROTOCOL, ...message })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 4 * MAX_MESSAGE_BYTES) return finish(() => reject(new ApprovalServiceError("SERVICE_PROTOCOL", "reply too large")));
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, nl)) as ServiceReply;
        finish(() => resolve(reply));
      } catch {
        finish(() => reject(new ApprovalServiceError("SERVICE_PROTOCOL", "the approval service sent a reply that is not JSON")));
      }
    });
    socket.on("error", (error) => finish(() => reject(new ApprovalServiceError("SERVICE_UNAVAILABLE", `the approval service is not reachable at ${endpoint}: ${(error as NodeJS.ErrnoException).code ?? error.message}`))));
    socket.on("end", () => finish(() => reject(new ApprovalServiceError("SERVICE_PROTOCOL", "the approval service closed the connection without a reply"))));
  });
}

export type ServiceAssessment = {
  endpoint: string;
  reachable: boolean;
  /** What this side can verify about the service, and what only the service says about itself. */
  isolated: boolean;
  reasons: string[];
  health?: ServiceHealth;
};

/**
 * The agent side's view of the service. "isolated" is true only when everything this process can check agrees:
 * the endpoint belongs to another principal, its directory is not writable by this one, and a production service
 * attests verified isolation. The attestation alone is not trusted (a same-user impostor could claim it); the
 * file-ownership evidence is checked independently. On Windows the endpoint owner is not inspectable from Node, so
 * isolation is reported unverified there until a Windows probe exists.
 */
export async function assessApprovalService(opts: { endpoint?: string; timeoutMs?: number } = {}): Promise<ServiceAssessment> {
  const endpoint = opts.endpoint ?? serviceEndpoint();
  const reasons: string[] = [];
  let health: ServiceHealth | undefined;
  try {
    const reply = await callApprovalService({ op: "health" }, { endpoint, timeoutMs: opts.timeoutMs ?? 5_000 });
    if (reply.ok) health = reply.health as ServiceHealth;
    else reasons.push(`health refused: ${reply.code}`);
  } catch (error) {
    return { endpoint, reachable: false, isolated: false, reasons: [(error as Error).message] };
  }
  if (!health) return { endpoint, reachable: true, isolated: false, reasons };
  if (health.mode !== "production") reasons.push("the service runs in development mode (same-identity, not an isolation boundary)");
  if (!health.isolation.verified) reasons.push("the service does not attest verified isolation");
  if (osPlatform() === "win32") {
    reasons.push("endpoint ownership cannot be verified from this process on Windows; isolation is reported unverified");
  } else {
    try {
      const owner = statSync(endpoint).uid;
      const me = process.getuid?.();
      if (me !== undefined && owner === me) reasons.push("the endpoint is owned by the same user as this process");
      try {
        accessSync(dirname(endpoint), constants.W_OK);
        reasons.push("this process can write to the endpoint's directory");
      } catch {
        /* not writable: expected */
      }
    } catch (error) {
      reasons.push(`cannot inspect the endpoint: ${(error as Error).message}`);
    }
  }
  return { endpoint, reachable: true, isolated: reasons.length === 0, reasons, health };
}
