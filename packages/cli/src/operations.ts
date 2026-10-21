import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  inferProjectConfig,
  loadProjectConfig,
  writeProjectConfig,
} from "@praxis/project-config";
import { createJiraProvider, loadJiraConfig, type JiraProvider, parseJiraTransitions } from "@praxis/jira";
import {
  architectPlanEpic,
  baAnalyzeEpic,
  claimWorkPackage,
  collectEpicStatus,
  developerCompleteWp,
  discoverLocalWorkPackages,
  releaseWorkPackage,
  resolveLocalWorkPackage,
  resolveRemoteWpKey,
  createPreviewTrace,
  WorkPackageScopeError,
  previewDeveloperCompleteRecovery,
  applyDeveloperCompleteRecovery,
  inspectDeveloperCompletion,
  discoverQualityInputs,
  previewQualityApply,
  applyQualityReview,
  QualityApplyError,
  collectQualityLifecycleSnapshot,
  inspectQualityComments,
  type DeveloperCompleteResult,
  type CompleteRecoveryPreview,
  type QualityApplyResult,
  type QualityLifecycleSnapshot,
  type QualityCommentReadback,
} from "@praxis/jira/workflow";
import { resolveWorkPackageRef, type ResolvedIdentifier } from "./identity.js";
import { doctorNextSteps, providerDiagnostics, securityDiagnostics } from "./diagnostics.js";
import { VcsError, githubTokenFlags, gitlabTokenFlags, type GitDeliveryJournal, type GitWriteFields } from "@praxis/vcs";
import {
  APPROVAL_SERVICE_PROTOCOL,
  SERVICE_OPERATIONS,
  approvalServiceDelegate,
  executionIdFor,
  recordedExecution,
  assessApprovalService,
  authorizeGitOperation,
  GitApprovalRequired,
  hasMutationLease,
  inspectMutation,
  runAuthorizedMutation,
  runWorkflowRecordWrite,
  securityMode,
  serviceDelegationActive,
  withGitExecutorDelegate,
  WorkflowError,
  type ApprovalOperation,
  type GitDescribed,
  type GitOperationKind,
} from "@praxis/contracts";
import {
  gitCommitData,
  gitConnectApplyData,
  gitConnectPreviewData,
  gitDeliveryStatusData,
  gitIdentityApplyData,
  gitIdentityPreviewData,
  gitMergeRequestData,
  gitMergeRequestPreviewData,
  gitPreviewData,
  gitPublishData,
  gitPublishPreviewData,
  gitStatusData,
  type GitOpContext,
} from "./git-delivery-ops.js";

export const OP_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  WORKFLOW_BLOCKED: "WORKFLOW_BLOCKED",
  EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",
  CONFLICT: "CONFLICT",
  LOCAL_RUNTIME_UNAVAILABLE: "LOCAL_RUNTIME_UNAVAILABLE",
  PRAXIS_RUNTIME_UNAVAILABLE: "PRAXIS_RUNTIME_UNAVAILABLE",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  REPOSITORY_UNAVAILABLE: "REPOSITORY_UNAVAILABLE",
  JIRA_CONFIG_UNAVAILABLE: "JIRA_CONFIG_UNAVAILABLE",
  BA_PREVIEW_TIMEOUT: "BA_PREVIEW_TIMEOUT",
  ARCHITECT_PREVIEW_TIMEOUT: "ARCHITECT_PREVIEW_TIMEOUT",
  JIRA_READ_TIMEOUT: "JIRA_READ_TIMEOUT",
  LOCAL_WP_READ_FAILED: "LOCAL_WP_READ_FAILED",
  DESIGN_READ_FAILED: "DESIGN_READ_FAILED",
  ARCHITECT_PLAN_BUILD_FAILED: "ARCHITECT_PLAN_BUILD_FAILED",
  WORK_PACKAGE_NOT_FOUND: "WORK_PACKAGE_NOT_FOUND",
  WORK_PACKAGE_OUT_OF_SCOPE: "WORK_PACKAGE_OUT_OF_SCOPE",
  WORK_PACKAGE_SUPERSEDED: "WORK_PACKAGE_SUPERSEDED",
  WORK_PACKAGE_INVALID_STATE: "WORK_PACKAGE_INVALID_STATE",
  WORK_PACKAGE_TITLE_INVALID: "WORK_PACKAGE_TITLE_INVALID",
  WORK_PACKAGE_SCOPE_AMBIGUOUS: "WORK_PACKAGE_SCOPE_AMBIGUOUS",
  JIRA_TRANSITION_ID_INVALID: "JIRA_TRANSITION_ID_INVALID",
  JIRA_TRANSITION_NOT_AVAILABLE: "JIRA_TRANSITION_NOT_AVAILABLE",
  WORK_PACKAGE_ALREADY_CLAIMED: "WORK_PACKAGE_ALREADY_CLAIMED",
  VERIFICATION_FAILED: "VERIFICATION_FAILED",
  PREMATURE_JIRA_DONE: "PREMATURE_JIRA_DONE",
  EVIDENCE_PERSIST_FAILED: "EVIDENCE_PERSIST_FAILED",
  HANDOFF_FAILED: "HANDOFF_FAILED",
  JIRA_PROPERTY_UPDATE_FAILED: "JIRA_PROPERTY_UPDATE_FAILED",
  QUALITY_PACKAGE_MISSING: "QUALITY_PACKAGE_MISSING",
  QUALITY_STARTUP_FAILED: "QUALITY_STARTUP_FAILED",
  QUALITY_PROCESS_EXITED: "QUALITY_PROCESS_EXITED",
  QUALITY_PORT_UNAVAILABLE: "QUALITY_PORT_UNAVAILABLE",
  QUALITY_DB_INIT_FAILED: "QUALITY_DB_INIT_FAILED",
  QUALITY_HEALTH_TIMEOUT: "QUALITY_HEALTH_TIMEOUT",
  QUALITY_RUNTIME_UNREACHABLE: "QUALITY_RUNTIME_UNREACHABLE",
  QUALITY_NODE_UNSUPPORTED: "QUALITY_NODE_UNSUPPORTED",
  QUALITY_SQLITE_UNAVAILABLE: "QUALITY_SQLITE_UNAVAILABLE",
  QUALITY_SQLITE_MODULE_LOAD_FAILED: "QUALITY_SQLITE_MODULE_LOAD_FAILED",
  QUALITY_CHILD_RUNTIME_MISMATCH: "QUALITY_CHILD_RUNTIME_MISMATCH",
  QUALITY_SPAWN_FAILED: "QUALITY_SPAWN_FAILED",
  QUALITY_EXECUTABLE_NOT_FOUND: "QUALITY_EXECUTABLE_NOT_FOUND",
  QUALITY_EXECUTABLE_NOT_PERMITTED: "QUALITY_EXECUTABLE_NOT_PERMITTED",
  QUALITY_REVIEW_STALE: "QUALITY_REVIEW_STALE",
  QUALITY_FINGERPRINT_MISMATCH: "QUALITY_FINGERPRINT_MISMATCH",
  QUALITY_CHANGE_SPEC_INVALID: "QUALITY_CHANGE_SPEC_INVALID",
  QUALITY_MANIFEST_MISSING: "QUALITY_MANIFEST_MISSING",
  QUALITY_INPUTS_INCONSISTENT: "QUALITY_INPUTS_INCONSISTENT",
  QUALITY_REVIEW_MISSING: "QUALITY_REVIEW_MISSING",
  QUALITY_PREVIEW_STALE: "QUALITY_PREVIEW_STALE",
  QUALITY_RECONCILIATION_REQUIRED: "QUALITY_RECONCILIATION_REQUIRED",
  QUALITY_POSTCONDITION_FAILED: "QUALITY_POSTCONDITION_FAILED",
  QUALITY_STORE_SYNC_PENDING: "QUALITY_STORE_SYNC_PENDING",
  QUALITY_APPLY_INCOMPLETE: "QUALITY_APPLY_INCOMPLETE",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  APPROVAL_FINGERPRINT_MISMATCH: "APPROVAL_FINGERPRINT_MISMATCH",
  APPROVAL_SCOPE_MISMATCH: "APPROVAL_SCOPE_MISMATCH",
  APPROVAL_SCOPE_SEPARATE: "APPROVAL_SCOPE_SEPARATE",
  APPROVAL_EXPIRED: "APPROVAL_EXPIRED",
  APPROVAL_REVOKED: "APPROVAL_REVOKED",
  APPROVAL_REJECTED: "APPROVAL_REJECTED",
  APPROVAL_RECONCILIATION_REQUIRED: "APPROVAL_RECONCILIATION_REQUIRED",
  APPROVAL_SELF_GRANT_FORBIDDEN: "APPROVAL_SELF_GRANT_FORBIDDEN",
  APPROVAL_AMBIGUOUS: "APPROVAL_AMBIGUOUS",
  APPROVAL_TRANSITION_FORBIDDEN: "APPROVAL_TRANSITION_FORBIDDEN",
  GIT_REPOSITORY_UNAVAILABLE: "GIT_REPOSITORY_UNAVAILABLE",
  GIT_IDENTITY_REQUIRED: "GIT_IDENTITY_REQUIRED",
  GIT_REMOTE_REQUIRED: "GIT_REMOTE_REQUIRED",
  GIT_REMOTE_SELECTION_REQUIRED: "GIT_REMOTE_SELECTION_REQUIRED",
  GIT_PROVIDER_UNKNOWN: "GIT_PROVIDER_UNKNOWN",
  GIT_PROVIDER_UNSUPPORTED: "GIT_PROVIDER_UNSUPPORTED",
  GIT_PREVIEW_STALE: "GIT_PREVIEW_STALE",
  GIT_QUALITY_SNAPSHOT_MISMATCH: "GIT_QUALITY_SNAPSHOT_MISMATCH",
  GIT_STAGING_BLOCKED: "GIT_STAGING_BLOCKED",
  GIT_FOREIGN_STAGED: "GIT_FOREIGN_STAGED",
  GIT_PUSH_BLOCKED: "GIT_PUSH_BLOCKED",
  GIT_FORCE_PUSH_FORBIDDEN: "GIT_FORCE_PUSH_FORBIDDEN",
  GIT_BASELINE_REQUIRED: "GIT_BASELINE_REQUIRED",
  GIT_REMOTE_HISTORY_CONFLICT: "GIT_REMOTE_HISTORY_CONFLICT",
  GITHUB_TOKEN_UNAVAILABLE: "GITHUB_TOKEN_UNAVAILABLE",
  GITHUB_API_URL_INVALID: "GITHUB_API_URL_INVALID",
  GITLAB_TOKEN_UNAVAILABLE: "GITLAB_TOKEN_UNAVAILABLE",
  GIT_TRANSPORT_FAILED: "GIT_TRANSPORT_FAILED",
  GIT_COMMIT_DIVERGED: "GIT_COMMIT_DIVERGED",
  GIT_CONFIRMATION_REQUIRED: "GIT_CONFIRMATION_REQUIRED",
  GIT_SECRETS_DETECTED: "GIT_SECRETS_DETECTED",
  GIT_REPRODUCIBILITY_BLOCKED: "GIT_REPRODUCIBILITY_BLOCKED",
} as const;

export type OpCode = (typeof OP_CODES)[keyof typeof OP_CODES];

export const PREVIEW_DEADLINE_MS = 15_000;

export class PraxisOpError extends Error {
  readonly code: OpCode;
  readonly stage?: string;
  readonly durationMs?: number;
  readonly details?: Record<string, unknown>;
  constructor(
    code: OpCode,
    message: string,
    extra?: { stage?: string; durationMs?: number; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "PraxisOpError";
    this.code = code;
    this.stage = extra?.stage;
    this.durationMs = extra?.durationMs;
    this.details = extra?.details;
  }
}

export function previewFingerprint(plan: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(plan ?? null)).digest("hex")}`;
}

export function redact(text: string): string {
  return text
    .replace(/PRAXIS_JIRA_TOKEN=\S+/g, "PRAXIS_JIRA_TOKEN=<redacted>")
    .replace(/PRAXIS_GITHUB_TOKEN=\S+/g, "PRAXIS_GITHUB_TOKEN=<redacted>")
    .replace(/PRAXIS_GITLAB_TOKEN=\S+/g, "PRAXIS_GITLAB_TOKEN=<redacted>")
    .replace(/Authorization:\s*\S+/gi, "Authorization=<redacted>")
    .replace(/Bearer\s+\S+/g, "Bearer <redacted>");
}

export type OpContext = {
  repo: string;
  epic?: string;
  wp?: string;
  confirmation?: string;
  previewFingerprint?: string;
  infer?: boolean;
  actor?: string;
  provider?: JiraProvider;
  requirePreviewFingerprint?: boolean;
  signal?: AbortSignal;
  deadlineMs?: number;
  reviewId?: number;
  remoteName?: string;
  remoteUrl?: string;
  branch?: string;
  targetBranch?: string;
  files?: string[];
  commitMessage?: string;
  gitUserName?: string;
  gitUserEmail?: string;
  gitPublishMode?: "baseline" | "branch";
  providerKind?: "github" | "gitlab";
  vcsFetchImpl?: typeof fetch;
  vcsProvider?: import("@praxis/vcs").VcsProvider;
  planId?: string;
  planFingerprint?: string;
  instanceId?: string;
  /** Set when an outer entry point already started the consumption ledger. */
  approvalConsumed?: boolean;
};

const HOST_PLACEHOLDER_RE = /^\$\{[^}]*\}$/;

/**
 * Claude Desktop passes optional extension settings left blank as the literal
 * `${user_config.<field>}` template. Such a value is unset, not configured.
 * Removes whole-value placeholders from PRAXIS_* keys and returns key names only.
 */
export function scrubUnexpandedPlaceholders(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith("PRAXIS_")) continue;
    const value = env[key];
    if (value !== undefined && HOST_PLACEHOLDER_RE.test(value.trim())) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

let hostPlaceholdersIgnored: string[] = [];

/**
 * Keys that decide who may approve a mutation. Repository files are writable by the agent, so
 * they must never supply these: only the operator's real environment can.
 */
const DOTENV_FORBIDDEN_PREFIXES = [
  "PRAXIS_SECURITY_",
  "PRAXIS_APPROVAL_",
  "PRAXIS_BROKER_",
  "PRAXIS_DEPLOYMENT_",
  "PRAXIS_ALLOW_",
  "PRAXIS_FIXTURE_",
  "PRAXIS_TEST_",
];

let dotenvRejected: string[] = [];

/** Names (never values) of trust-configuration keys a repository file tried to set. */
export function dotenvRejectedKeys(): string[] {
  return dotenvRejected;
}

function dotenvKeyForbidden(key: string): boolean {
  return DOTENV_FORBIDDEN_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function loadPraxisDotenv(repo: string): void {
  const removed = scrubUnexpandedPlaceholders();
  if (removed.length) {
    hostPlaceholdersIgnored = [...new Set([...hostPlaceholdersIgnored, ...removed])].sort();
  }
  if (process.env.PRAXIS_SKIP_DOTENV === "1") return;
  const resolved = resolve(repo);
  if (!existsSync(resolved)) return;
  for (const f of [".env.praxis", ".env", ".env.praxis.local"]) {
    const p = join(resolved, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      if (dotenvKeyForbidden(m[1]!)) {
        if (!dotenvRejected.includes(m[1]!)) dotenvRejected = [...dotenvRejected, m[1]!].sort();
        continue;
      }
      if (process.env[m[1]!]) continue;
      process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
}

function gitRoot(cwd: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 2000,
  });
  if ((r.status ?? 1) !== 0) return undefined;
  return r.stdout.trim() || undefined;
}

function requireRepo(repo: string): string {
  loadPraxisDotenv(repo);
  const resolved = resolve(repo);
  if (!existsSync(resolved)) {
    throw new PraxisOpError(
      OP_CODES.REPOSITORY_UNAVAILABLE,
      `REPOSITORY_UNAVAILABLE: ${resolved}`,
    );
  }
  return resolved;
}

export function jiraConfigFlags() {
  const baseUrlConfigured = Boolean(process.env.PRAXIS_JIRA_BASE_URL);
  const emailConfigured = Boolean(process.env.PRAXIS_JIRA_EMAIL);
  const projectKeyConfigured = Boolean(process.env.PRAXIS_JIRA_PROJECT_KEY);
  const tokenConfigured = Boolean(process.env.PRAXIS_JIRA_TOKEN);
  const missing: string[] = [];
  if (!baseUrlConfigured) missing.push("jira_base_url");
  if (!emailConfigured) missing.push("jira_email");
  if (!projectKeyConfigured) missing.push("jira_project_key");
  if (!tokenConfigured) missing.push("jira_token");
  return {
    baseUrlConfigured,
    emailConfigured,
    projectKeyConfigured,
    tokenConfigured,
    missing,
    configured: missing.length === 0,
    operationsReady: Boolean(baseUrlConfigured && tokenConfigured && projectKeyConfigured),
  };
}

function jiraConfigured(): boolean {
  return Boolean(
    process.env.PRAXIS_JIRA_BASE_URL &&
      process.env.PRAXIS_JIRA_TOKEN &&
      process.env.PRAXIS_JIRA_PROJECT_KEY,
  );
}

function jiraConfigUnavailableMessage(flags = jiraConfigFlags()): string {
  const missing = flags.missing.length ? flags.missing.join(", ") : "jira_base_url, jira_email, jira_project_key, jira_token";
  return `JIRA_CONFIG_UNAVAILABLE: missing ${missing}. Open Claude Desktop → Settings → Extensions → Praxis Runtime → Settings, or set PRAXIS_JIRA_* for CLI/CI. Do not paste tokens into chat.`;
}

function mapJiraWorkflowError(err: unknown): never {
  if (err instanceof PraxisOpError) throw err;
  const rec = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined;
  const code = typeof rec?.code === "string" ? rec.code : "";
  if (code === "JIRA_TRANSITION_ID_INVALID" || code === "JIRA_TRANSITION_NOT_AVAILABLE") {
    throw new PraxisOpError(code, redact(err instanceof Error ? err.message : String(err)), {
      details: {
        issueKey: rec?.issueKey,
        semanticAction: rec?.semanticAction,
        resolvedValue: rec?.resolvedValue,
        currentStatus: rec?.currentStatus,
        available: rec?.available,
      },
    });
  }
  if (code === "WORK_PACKAGE_ALREADY_CLAIMED") {
    throw new PraxisOpError(OP_CODES.WORK_PACKAGE_ALREADY_CLAIMED, redact(err instanceof Error ? err.message : String(err)), {
      details: { issueKey: rec?.issueKey, actor: rec?.actor },
    });
  }
  if (
    code === "VERIFICATION_FAILED" ||
    code === "PREMATURE_JIRA_DONE" ||
    code === "EVIDENCE_PERSIST_FAILED" ||
    code === "HANDOFF_FAILED" ||
    code === "JIRA_PROPERTY_UPDATE_FAILED"
  ) {
    throw new PraxisOpError(code as OpCode, redact(err instanceof Error ? err.message : String(err)), {
      details: rec?.details && typeof rec.details === "object" ? (rec.details as Record<string, unknown>) : rec,
    });
  }
  throw err;
}

async function withProvider<T>(
  ctx: OpContext,
  fn: (p: JiraProvider) => Promise<T>,
): Promise<T> {
  const run = async (p: JiraProvider) => {
    try {
      return await fn(p);
    } catch (e) {
      return mapJiraWorkflowError(e);
    }
  };
  if (ctx.provider) return run(ctx.provider);
  if (!jiraConfigured()) {
    throw new PraxisOpError(OP_CODES.JIRA_CONFIG_UNAVAILABLE, jiraConfigUnavailableMessage());
  }
  try {
    const config = loadJiraConfig();
    return await run(
      createJiraProvider({
        config,
        signal: ctx.signal,
      }),
    );
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e));
    if (e instanceof PraxisOpError) throw e;
    if (/timeout|aborted/i.test(msg)) {
      throw new PraxisOpError(OP_CODES.JIRA_READ_TIMEOUT, `JIRA_READ_TIMEOUT: ${msg}`);
    }
    throw new PraxisOpError(OP_CODES.EXTERNAL_SERVICE_ERROR, msg);
  }
}

function previewDeadlineMs(ctx: OpContext): number {
  const fromEnv = Number(process.env.PRAXIS_PREVIEW_DEADLINE_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (typeof ctx.deadlineMs === "number" && ctx.deadlineMs > 0) return ctx.deadlineMs;
  return PREVIEW_DEADLINE_MS;
}

async function withPreviewDeadline<T extends object>(opts: {
  op: "ba-preview" | "architect-preview";
  code: typeof OP_CODES.BA_PREVIEW_TIMEOUT | typeof OP_CODES.ARCHITECT_PREVIEW_TIMEOUT;
  ctx: OpContext;
  run: (args: {
    signal: AbortSignal;
    trace: ReturnType<typeof createPreviewTrace>;
  }) => Promise<T>;
}): Promise<T & { durationMs: number; stages: Record<string, number> }> {
  const deadlineMs = previewDeadlineMs(opts.ctx);
  const trace = createPreviewTrace(opts.op);
  const tag = opts.op === "ba-preview" ? "praxis-ba-preview" : "praxis-architect-preview";
  console.error(`[${tag}] start`);
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  const onExternalAbort = () => ac.abort();
  opts.ctx.signal?.addEventListener("abort", onExternalAbort);
  let lastStage = "start";
  const innerLog = trace.log.bind(trace);
  trace.log = (event) => {
    if (event.phase === "start") lastStage = event.stage;
    innerLog(event);
  };
  try {
    const result = await Promise.race([
      opts.run({ signal: ac.signal, trace }),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener("abort", () => {
          const durationMs = Date.now() - started;
          reject(
            new PraxisOpError(
              opts.code,
              `${opts.code}: stage=${lastStage} durationMs=${durationMs}`,
              { stage: lastStage, durationMs },
            ),
          );
        });
      }),
    ]);
    const durationMs = Date.now() - started;
    console.error(`[${tag}] done durationMs=${durationMs}`);
    return { ...result, durationMs, stages: { ...trace.stages } };
  } catch (e) {
    if (e instanceof PraxisOpError) throw e;
    const durationMs = Date.now() - started;
    const msg = redact(e instanceof Error ? e.message : String(e));
    if (/timeout|aborted/i.test(msg)) {
      throw new PraxisOpError(
        opts.code,
        `${opts.code}: stage=${lastStage} durationMs=${durationMs}`,
        { stage: lastStage, durationMs },
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
    opts.ctx.signal?.removeEventListener("abort", onExternalAbort);
  }
}

function requireConfirm(confirmation: string | undefined, what: string): void {
  if (confirmation !== "YES") {
    throw new PraxisOpError(
      OP_CODES.CONFIRMATION_REQUIRED,
      `${what} requires confirmation=YES`,
    );
  }
}

type ProtectedSpec = {
  what: string;
  action: string;
  operation: ApprovalOperation;
  provider: "local" | "jira";
  repository: string;
  workItemId?: string;
  requireYes: boolean;
  /**
   * Set for protected Git operations. In secure mode they are authorized request by request through the broker's
   * inbox (see authorizeGitOperation); this describes the live request so the owner is shown, and the token binds,
   * exactly what will run. It must throw when the caller's preview is stale.
   */
  git?: { describe: () => Promise<GitDescribed> | GitDescribed };
};

function replayResult<T>(result: unknown): T {
  if (result && typeof result === "object") return { ...(result as object), replayed: true } as T;
  return { replayed: true, result } as T;
}

function asApprovalError(err: unknown): never {
  if (err instanceof WorkflowError && err.code in OP_CODES) {
    throw new PraxisOpError(err.code as OpCode, err.message);
  }
  throw err;
}

/**
 * confirmation=YES is an extra compatibility check. It never authorizes a write.
 * The persisted approval is checked before the mutation.
 */
async function guardWrite<T>(ctx: OpContext, spec: ProtectedSpec, write: () => Promise<T> | T): Promise<T> {
  if (spec.requireYes) requireConfirm(ctx.confirmation, spec.what);
  const repo = resolve(spec.repository);
  if (spec.git && securityMode() === "secure" && !hasMutationLease() && (SERVICE_OPERATIONS as readonly string[]).includes(spec.operation) && serviceDelegationActive()) {
    // The Approval Service is the authority and the executor: it derives the plan from the repository, shows it to the
    // owner, and runs the commit / push / merge request itself under its own OS identity. This process only prepares,
    // verifies and keeps its delivery journal; the journal write below runs under the workflow-record lease because
    // it records what the service did, it does not authorize anything.
    const executionId = executionIdFor({ operation: spec.operation, repository: repo, workItemId: spec.workItemId ?? "", previewFingerprint: ctx.previewFingerprint ?? "" });
    // The same logical operation, asked again after it completed, returns what the service recorded. It does not matter
    // that the repository has moved on (a commit changes HEAD): nothing runs a second time.
    const recorded = await recordedExecution(executionId);
    if (recorded) {
      return { ok: true, writeSucceeded: false, verificationStatus: "ok", partial: false, completed: true, replayed: true, executedBy: "approval-service", executionId, serviceResult: recorded } as unknown as T;
    }
    try {
      return await runWorkflowRecordWrite(() => withGitExecutorDelegate(approvalServiceDelegate(undefined, executionId), write));
    } catch (err) {
      if (err instanceof GitApprovalRequired) {
        throw new PraxisOpError(err.code as OpCode, err.message, { details: err.details });
      }
      asApprovalError(err);
    }
  }
  if (spec.git && securityMode() === "secure" && !hasMutationLease()) {
    // Secure mode: no stored approval file, no environment token. One broker authorization per request.
    try {
      return await authorizeGitOperation({
        repo,
        key: {
          operation: spec.operation as GitOperationKind,
          action: spec.action,
          repository: repo,
          workItemId: spec.workItemId ?? "",
          previewFingerprint: ctx.previewFingerprint ?? "",
        },
        describe: spec.git.describe,
        write,
      });
    } catch (err) {
      if (err instanceof GitApprovalRequired) {
        throw new PraxisOpError(err.code as OpCode, err.message, { details: err.details });
      }
      asApprovalError(err);
    }
  }
  let inspection;
  try {
    inspection = inspectMutation({
      repo,
      planId: ctx.planId,
      planFingerprint: ctx.planFingerprint,
      operation: spec.operation,
      provider: spec.provider,
      instanceId: spec.provider === "local" ? undefined : (ctx.instanceId ?? process.env.PRAXIS_JIRA_BASE_URL),
      workItemId: spec.workItemId,
      repository: repo,
      previewFingerprint: ctx.previewFingerprint,
      action: spec.action,
      resumeInFlight: Boolean(ctx.approvalConsumed),
    });
  } catch (err) {
    asApprovalError(err);
  }
  if (inspection.kind === "replay") return replayResult<T>(inspection.result);
  try {
    return await runAuthorizedMutation({
      repo,
      planId: ctx.planId,
      planFingerprint: ctx.planFingerprint,
      operation: spec.operation,
      provider: spec.provider,
      instanceId: spec.provider === "local" ? undefined : (ctx.instanceId ?? process.env.PRAXIS_JIRA_BASE_URL),
      workItemId: spec.workItemId,
      repository: repo,
      previewFingerprint: ctx.previewFingerprint,
      action: spec.action,
      resumeInFlight: true,
    }, write);
  } catch (err) {
    asApprovalError(err);
  }
}

function requireFingerprint(expected: string, got: string | undefined, what: string): void {
  if (!got) {
    throw new PraxisOpError(
      OP_CODES.CONFIRMATION_REQUIRED,
      `${what} requires previewFingerprint from the matching preview`,
    );
  }
  if (got !== expected) {
    throw new PraxisOpError(
      OP_CODES.CONFLICT,
      `${what} previewFingerprint mismatch (stale preview or state drift)`,
    );
  }
}

async function tracedFingerprint(
  trace: ReturnType<typeof createPreviewTrace>,
  plan: unknown,
): Promise<string> {
  const t0 = Date.now();
  trace.log({ op: trace.op, stage: "fingerprint", phase: "start" });
  const fp = previewFingerprint(plan);
  trace.log({
    op: trace.op,
    stage: "fingerprint",
    phase: "done",
    durationMs: Date.now() - t0,
  });
  return fp;
}

/**
 * What the agent side can honestly say about the Approval Service. "isolated" needs agreement of file-ownership
 * evidence and the service's own production attestation; installing the Desktop extension alone never produces it.
 */
async function approvalServiceDiagnostics(): Promise<Record<string, unknown>> {
  const assessment = await assessApprovalService({ timeoutMs: 3000 });
  const health = assessment.health;
  const compatible = health ? health.protocol === APPROVAL_SERVICE_PROTOCOL : undefined;
  return {
    endpoint: assessment.endpoint,
    reachable: assessment.reachable,
    isolated: assessment.isolated && compatible === true,
    delegating: serviceDelegationActive(),
    reasons: assessment.reasons,
    ...(health
      ? { version: health.version, protocol: health.protocol, protocolCompatible: compatible, mode: health.mode, platform: health.platform, operatorChannel: health.operatorChannel, pending: health.pending, auditChain: health.auditChain, selfReportedIsolation: health.isolation }
      : {}),
    note: assessment.reachable
      ? assessment.isolated
        ? "The service answers, runs in production mode, and its endpoint belongs to another principal."
        : "The service answers but OS-level isolation is NOT established; see reasons."
      : "No approval service is reachable. Installing the Desktop extension alone does not provide OS-level isolation; install the native Approval Service (docs/approval-service/INSTALL.md).",
  };
}

export async function doctorOp(ctx: OpContext, version: string): Promise<Record<string, unknown>> {
  loadPraxisDotenv(ctx.repo);
  const resolved = resolve(ctx.repo);
  const repoExists = existsSync(resolved);
  const git = repoExists ? gitRoot(resolved) : undefined;
  const project = repoExists
    ? loadProjectConfig(git ?? resolved)
    : { status: "missing" as const, suggestedPath: resolved };
  const jiraFlags = jiraConfigFlags();
  const jira = {
    baseUrlConfigured: jiraFlags.baseUrlConfigured,
    emailConfigured: jiraFlags.emailConfigured,
    projectKeyConfigured: jiraFlags.projectKeyConfigured,
    tokenConfigured: jiraFlags.tokenConfigured,
    configured: jiraFlags.configured,
    missing: jiraFlags.missing,
  };
  const { probeQuality } = await import("./quality-ensure.js");
  const qualityProbe = repoExists
    ? await probeQuality({ repo: git ?? resolved })
    : { status: "not_started" as const, url: process.env.PRAXIS_QUALITY_URL || "http://127.0.0.1:8792/health", reused: false };
  const quality = {
    healthy: qualityProbe.status === "healthy",
    status: qualityProbe.status,
    url: qualityProbe.url,
    pid: qualityProbe.pid,
    db: qualityProbe.db,
  };
  const github = githubTokenFlags();
  const gitlab = gitlabTokenFlags();
  const providers = providerDiagnostics(process.env, {
    configured: github.apiUrlConfigured,
    valid: github.apiUrlValid !== false,
    issue: github.apiUrlIssue,
  });
  const security = securityDiagnostics(process.env, git ?? resolved);
  const approvalService = await approvalServiceDiagnostics();
  const capabilities = {
    praxisRuntime: "ok",
    repository: repoExists ? (git ? "ok" : "no-git") : "unavailable",
    localRuntime: "ok",
    jiraConfig: jiraFlags.operationsReady ? "ok" : "unavailable",
  };
  return {
    version,
    repo: git ?? (repoExists ? resolved : null),
    gitRoot: git ?? null,
    project: {
      status: project.status,
      path: "path" in project ? project.path : undefined,
      suggestedPath: "suggestedPath" in project ? project.suggestedPath : undefined,
    },
    jira,
    github,
    gitlab,
    quality,
    capabilities,
    hostPlaceholdersIgnored,
    dotenvRejected,
    providers,
    security,
    approvalService,
    nextSteps: [
      ...doctorNextSteps({
      repoExists,
      gitRoot: Boolean(git),
      project: project.status,
      quality: { status: qualityProbe.status, logPath: (qualityProbe as { logPath?: string }).logPath },
      providers,
      security,
      dotenvRejected,
    }),
      ...(approvalService.reachable ? [] : ["No Approval Service is running: OS-level approval isolation is not in place. Install the native service (docs/approval-service/INSTALL.md); the Desktop extension alone makes no isolation claim."]),
    ],
    codes: {
      repository:
        capabilities.repository === "unavailable" ? OP_CODES.REPOSITORY_UNAVAILABLE : undefined,
      jira: capabilities.jiraConfig === "unavailable" ? OP_CODES.JIRA_CONFIG_UNAVAILABLE : undefined,
      github: github.apiUrlValid === false ? OP_CODES.GITHUB_API_URL_INVALID : undefined,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      localExecution: true,
    },
    roleContext: ["ba", "architect", "developer", "quality"],
  };
}

export async function projectStatusOp(ctx: OpContext) {
  const repo = requireRepo(ctx.repo);
  return { status: loadProjectConfig(repo) };
}

export async function projectInitPreviewOp(ctx: OpContext) {
  const repo = requireRepo(ctx.repo);
  const inferred = inferProjectConfig(repo);
  return {
    wrote: false,
    preview: inferred.proposed,
    yaml: inferred.yaml,
    notes: inferred.notes,
    existing: inferred.existing.status,
  };
}

export async function projectInitApplyOp(ctx: OpContext) {
  const repo = requireRepo(ctx.repo);
  const inferred = inferProjectConfig(repo);
  return guardWrite(ctx, {
    what: "project init",
    action: "praxis_project_init_apply",
    operation: "repository_edit",
    provider: "local",
    repository: repo,
    requireYes: true,
  }, async () => {
    if (inferred.existing.status === "loaded") {
      return {
        wrote: false,
        reason: "already-exists" as const,
        path: inferred.existing.path,
      };
    }
    const path = writeProjectConfig(repo, inferred.yaml);
    return { wrote: true, path, config: inferred.proposed };
  });
}

export async function jiraSmokeOp(ctx: OpContext) {
  return withProvider(ctx, (p) => p.verifyConnection());
}

export async function jiraDiscoverOp(ctx: OpContext): Promise<{
  issueTypes: unknown;
  epicTypeId: unknown;
  storyTypeId: unknown;
  taskTypeId: unknown;
  bugTypeId: unknown;
}> {
  return withProvider(ctx, async (provider) => {
    const meta = await provider.discoverMetadata();
    return {
      issueTypes: meta.issueTypes,
      epicTypeId: meta.epicTypeId,
      storyTypeId: meta.storyTypeId,
      taskTypeId: meta.taskTypeId,
      bugTypeId: meta.bugTypeId,
    };
  });
}

export async function jiraEpicOp(ctx: OpContext): Promise<{ epic: unknown; children: unknown }> {
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "jira epic requires epic");
  }
  return withProvider(ctx, async (provider) => {
    const issue = await provider.getIssue(ctx.epic!);
    const children = await provider.getChildren(ctx.epic!);
    return { epic: issue, children };
  });
}

export async function jiraStatusOp(ctx: OpContext) {
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "jira status requires epic");
  }
  return withProvider(ctx, (p) => collectEpicStatus(p, ctx.epic!));
}

export async function baStatusOp(ctx: OpContext) {
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "ba status requires epic");
  }
  const repo = requireRepo(ctx.repo);
  return withProvider({ ...ctx, repo }, (p) => collectEpicStatus(p, ctx.epic!));
}

export async function baPreviewOp(ctx: OpContext) {
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "ba preview requires epic");
  }
  const repo = requireRepo(ctx.repo);
  return withPreviewDeadline({
    op: "ba-preview",
    code: OP_CODES.BA_PREVIEW_TIMEOUT,
    ctx,
    run: ({ signal, trace }) =>
      withProvider({ ...ctx, repo, signal }, async (p) => {
        const result = await baAnalyzeEpic({
          provider: p,
          epicKey: ctx.epic!,
          repo,
          dryRun: true,
          trace,
        });
        const fingerprint = await tracedFingerprint(trace, result.plan);
        return { ...result, previewFingerprint: fingerprint };
      }),
  });
}

export async function baApplyOp(ctx: OpContext) {
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "ba apply requires epic");
  }
  const repo = requireRepo(ctx.repo);
  return guardWrite(ctx, {
    what: "ba apply",
    action: "praxis_ba_apply",
    operation: "external_record_update",
    provider: "jira",
    repository: repo,
    workItemId: ctx.epic,
    requireYes: true,
  }, () => withProvider({ ...ctx, repo }, async (p) => {
    const preview = await baAnalyzeEpic({
      provider: p,
      epicKey: ctx.epic!,
      repo,
      dryRun: true,
    });
    const fp = previewFingerprint(preview.plan);
    if (ctx.requirePreviewFingerprint || ctx.previewFingerprint) {
      requireFingerprint(fp, ctx.previewFingerprint, "ba apply");
    }
    const result = await baAnalyzeEpic({
      provider: p,
      epicKey: ctx.epic!,
      repo,
      dryRun: false,
    });
    return { ...result, previewFingerprint: previewFingerprint(result.plan) };
  }));
}

export async function architectStatusOp(ctx: OpContext) {
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "architect status requires epic");
  }
  const repo = requireRepo(ctx.repo);
  return withProvider({ ...ctx, repo }, (p) => collectEpicStatus(p, ctx.epic!));
}

function mapArchitectWpError(e: unknown): never {
  if (e instanceof WorkPackageScopeError) {
    throw new PraxisOpError(e.code as OpCode, e.message);
  }
  throw e as Error;
}

export async function architectPreviewOp(ctx: OpContext) {
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "architect preview requires epic");
  }
  const repo = requireRepo(ctx.repo);
  return withPreviewDeadline({
    op: "architect-preview",
    code: OP_CODES.ARCHITECT_PREVIEW_TIMEOUT,
    ctx,
    run: ({ signal, trace }) =>
      withProvider({ ...ctx, repo, signal }, async (p) => {
        try {
          const result = await architectPlanEpic({
            provider: p,
            epicKey: ctx.epic!,
            repo,
            dryRun: true,
            trace,
            workPackageId: ctx.wp,
          });
          const fingerprint = await tracedFingerprint(trace, result.plan);
          return { ...result, previewFingerprint: fingerprint };
        } catch (e) {
          if (e instanceof WorkPackageScopeError) mapArchitectWpError(e);
          const msg = e instanceof Error ? e.message : String(e);
          if (/WORK_PACKAGE_/.test(msg)) {
            const code = (msg.match(/^(WORK_PACKAGE_[A-Z_]+)/)?.[1] ??
              OP_CODES.VALIDATION_FAILED) as OpCode;
            throw new PraxisOpError(code, redact(msg));
          }
          if (/ARCHITECT_DESIGN_MISSING|ENOENT|design/i.test(msg)) {
            throw new PraxisOpError(
              OP_CODES.DESIGN_READ_FAILED,
              `DESIGN_READ_FAILED: ${redact(msg)}`,
            );
          }
          if (/plan/i.test(msg) && !/timeout/i.test(msg)) {
            throw new PraxisOpError(
              OP_CODES.ARCHITECT_PLAN_BUILD_FAILED,
              `ARCHITECT_PLAN_BUILD_FAILED: ${redact(msg)}`,
            );
          }
          throw e;
        }
      }),
  });
}

export async function architectApplyOp(ctx: OpContext) {
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "architect apply requires epic");
  }
  const repo = requireRepo(ctx.repo);
  return guardWrite(ctx, {
    what: "architect apply",
    action: "praxis_architect_apply",
    operation: "external_record_update",
    provider: "jira",
    repository: repo,
    workItemId: ctx.epic,
    requireYes: true,
  }, () => withProvider({ ...ctx, repo }, async (p) => {
    try {
      const preview = await architectPlanEpic({
        provider: p,
        epicKey: ctx.epic!,
        repo,
        dryRun: true,
        workPackageId: ctx.wp,
      });
      const fp = previewFingerprint(preview.plan);
      if (ctx.requirePreviewFingerprint || ctx.previewFingerprint) {
        requireFingerprint(fp, ctx.previewFingerprint, "architect apply");
      }
      const result = await architectPlanEpic({
        provider: p,
        epicKey: ctx.epic!,
        repo,
        dryRun: false,
        workPackageId: ctx.wp,
      });
      return { ...result, previewFingerprint: previewFingerprint(result.plan) };
    } catch (e) {
      if (e instanceof WorkPackageScopeError) mapArchitectWpError(e);
      throw e;
    }
  }));
}

/**
 * A work-package argument must be a local Work Package id or a Jira issue key. A Work Item id is a different
 * identity and is refused with a pointer to the right parameter; a value that is neither is refused rather than
 * passed on as if it were a Jira key.
 */
function requireWorkPackageIdentity(repo: string, value: string): ResolvedIdentifier {
  const resolved = resolveWorkPackageRef(repo, value);
  if (resolved.kind === "work-item-id") {
    throw new PraxisOpError(
      OP_CODES.INVALID_INPUT,
      `${value} is a Work Item id, not a Work Package or Jira key. Use workItemId for Work Items (praxis_workflow_status, praxis_developer_status workItemId).`,
      { details: { identifierKind: "work-item-id", input: value } },
    );
  }
  if (resolved.kind === "unknown") {
    throw new PraxisOpError(
      OP_CODES.INVALID_INPUT,
      `${value} is not a local Work Package id (WP-YYYYMMDD-NNN) or a Jira issue key (PROJ-123).`,
      { details: { identifierKind: "unknown", input: value } },
    );
  }
  return resolved;
}

export async function workPackageListOp(ctx: OpContext) {
  const repo = requireRepo(ctx.repo);
  const list = discoverLocalWorkPackages(repo).map((w) => ({
    id: w.id,
    designDir: w.designDir,
    manifestDir: w.manifestDir,
    changeSpecPath: w.changeSpecPath,
    jiraIssueKey: resolveRemoteWpKey(repo, w.id) === w.id ? undefined : resolveRemoteWpKey(repo, w.id),
  }));
  return { workPackages: list };
}

export async function workPackageShowOp(ctx: OpContext): Promise<{
  local: unknown;
  identity: ResolvedIdentifier;
  jiraIssueKey: string | null;
}> {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "work-package show requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  const identity = requireWorkPackageIdentity(repo, ctx.wp);
  const local = resolveLocalWorkPackage(repo, ctx.wp);
  if (!local) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, `work package not found: ${ctx.wp}`);
  }
  return {
    local,
    identity,
    jiraIssueKey: identity.jiraIssueKey,
  };
}

export async function developerStatusOp(ctx: OpContext): Promise<Record<string, unknown>> {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer status requires workPackage");
  }
  const wp = ctx.wp;
  const repo = requireRepo(ctx.repo);
  const identity = requireWorkPackageIdentity(repo, wp);
  const local = resolveLocalWorkPackage(repo, wp);
  // Only a key the Work Package records, or a value that is itself a Jira key. Never the input echoed back.
  const jiraIssueKey = identity.jiraIssueKey;
  const wpId = local?.id ?? wp;
  const inspection = inspectDeveloperCompletion(repo, wpId);
  const qualityInputs = discoverQualityInputs(repo, wpId);
  const base = {
    wp,
    identity,
    local: local?.id,
    jiraIssueKey,
    implementationState: inspection.implementationState ?? null,
    readyForQuality: inspection.readyForQuality === true,
    hasCompletionEvidence: inspection.hasEvidence,
    hasQualityHandoff: inspection.hasHandoff,
    evidencePath: inspection.hasEvidence ? inspection.evidencePath : undefined,
    qualityHandoffPath: inspection.hasHandoff ? inspection.qualityHandoffPath : undefined,
    qualityInputs,
  };
  const attachLifecycle = async (provider?: Parameters<typeof collectQualityLifecycleSnapshot>[0]["provider"]) => {
    const lifecycle = await collectQualityLifecycleSnapshot({
      provider,
      repo,
      workPackageId: wpId,
      jiraIssueKey: jiraIssueKey ?? undefined,
    });
    return {
      ...base,
      qualityState: lifecycle.qualityState,
      appliedReviewId: lifecycle.appliedReviewId,
      reviewId: lifecycle.reviewId,
      claimState: lifecycle.claimState,
      jiraStatus: lifecycle.jiraStatus ?? null,
      jiraStatusCategory: lifecycle.jiraStatusCategory ?? null,
      qualityConsistency: lifecycle.overallConsistency,
      qualitySources: lifecycle.sources,
      qualityDiagnostics: lifecycle.consistency,
    };
  };
  if (!ctx.provider && !jiraConfigured()) {
    return attachLifecycle();
  }
  if (!jiraIssueKey) {
    return attachLifecycle();
  }
  return withProvider({ ...ctx, repo }, async (p) => {
    const issue = await p.getIssue(jiraIssueKey);
    const available = parseJiraTransitions({
      transitions: await p.getTransitions(jiraIssueKey),
    });
    const claim = await p.getIssueProperty(jiraIssueKey, "praxis.claim");
    const lifecycle = await attachLifecycle(p);
    return {
      ...lifecycle,
      jiraStatus: issue.status,
      jiraStatusCategory: issue.statusCategory,
      claim: claim ?? null,
      claimState:
        claim && typeof claim === "object" && "state" in claim
          ? (claim as { state?: string }).state
          : lifecycle.claimState,
      availableTransitions: available.map((t) => ({
        id: t.id,
        name: t.name,
        toStatus: t.toStatus,
      })),
    };
  });
}

export async function developerClaimOp(ctx: OpContext) {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer claim requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  return guardWrite(ctx, {
    what: "developer claim",
    action: "praxis_developer_claim",
    operation: "external_state_change",
    provider: "jira",
    repository: repo,
    workItemId: ctx.wp,
    requireYes: false,
  }, () => withProvider({ ...ctx, repo }, async (p) => {
    const user = await p.getCurrentUser();
    return claimWorkPackage({
      provider: p,
      wpKey: ctx.wp!,
      repo,
      actor: ctx.actor ?? user.displayName ?? "developer",
      accountId: user.accountId,
    });
  }));
}

export async function developerReleaseOp(ctx: OpContext) {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer release requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  return guardWrite(ctx, {
    what: "developer release",
    action: "praxis_developer_release",
    operation: "external_state_change",
    provider: "jira",
    repository: repo,
    workItemId: ctx.wp,
    requireYes: true,
  }, () => withProvider({ ...ctx, repo }, async (p) => {
    await releaseWorkPackage({
      provider: p,
      wpKey: resolveRemoteWpKey(repo, ctx.wp!),
      repo,
      confirm: true,
    });
    return { released: true, wp: ctx.wp };
  }));
}

export async function developerCompleteOp(ctx: OpContext): Promise<DeveloperCompleteResult> {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer complete requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  const wp = ctx.wp;
  return guardWrite(ctx, {
    what: "developer complete",
    action: "praxis_developer_complete",
    operation: "external_state_change",
    provider: "jira",
    repository: repo,
    workItemId: wp,
    requireYes: true,
  }, () => withProvider({ ...ctx, repo }, (p) =>
    developerCompleteWp({
      provider: p,
      wpKey: wp,
      repo,
    }),
  ));
}

export async function developerCompleteRecoveryPreviewOp(
  ctx: OpContext,
): Promise<CompleteRecoveryPreview> {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer complete recovery preview requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  const wp = ctx.wp;
  return withProvider({ ...ctx, repo }, (p) =>
    previewDeveloperCompleteRecovery({
      provider: p,
      wpKey: wp,
      repo,
    }),
  );
}

export async function developerCompleteRecoveryApplyOp(
  ctx: OpContext,
): Promise<DeveloperCompleteResult> {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer complete recovery apply requires workPackage");
  }
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(
      OP_CODES.CONFIRMATION_REQUIRED,
      "developer complete recovery apply requires previewFingerprint from the matching preview",
    );
  }
  const repo = requireRepo(ctx.repo);
  const wp = ctx.wp;
  const previewFingerprint = ctx.previewFingerprint;
  return guardWrite(ctx, {
    what: "developer complete recovery",
    action: "praxis_developer_complete_recovery_apply",
    operation: "external_state_change",
    provider: "jira",
    repository: repo,
    workItemId: wp,
    requireYes: true,
  }, () => withProvider({ ...ctx, repo }, (p) =>
    applyDeveloperCompleteRecovery({
      provider: p,
      wpKey: wp,
      repo,
      previewFingerprint,
    }),
  ));
}

export async function qualityStatusOp(ctx: OpContext) {
  const repo = requireRepo(ctx.repo);
  const { probeQuality } = await import("./quality-ensure.js");
  const health = await probeQuality({ repo });
  if (!ctx.wp) return health;
  const { qualityReviewStatus } = await import("./quality-lifecycle.js");
  const local = resolveLocalWorkPackage(repo, ctx.wp);
  const workPackageId = local?.id ?? ctx.wp;
  const review = qualityReviewStatus(repo, workPackageId);
  const load = async (provider?: Parameters<typeof collectQualityLifecycleSnapshot>[0]["provider"]) => {
    const lifecycle = await collectQualityLifecycleSnapshot({
      provider,
      repo,
      workPackageId,
      jiraIssueKey: resolveRemoteWpKey(repo, workPackageId),
    });
    return {
      ...health,
      workPackage: workPackageId,
      review,
      qualityState: lifecycle.qualityState,
      appliedReviewId: lifecycle.appliedReviewId,
      jiraStatus: lifecycle.jiraStatus ?? null,
      jiraStatusCategory: lifecycle.jiraStatusCategory ?? null,
      qualityConsistency: lifecycle.overallConsistency,
      qualityDiagnostics: lifecycle.consistency,
    };
  };
  if (!ctx.provider && !jiraConfigured()) return load();
  const jiraIssueKey = resolveRemoteWpKey(repo, workPackageId);
  if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(jiraIssueKey)) return load();
  return withProvider({ ...ctx, repo }, (p) => load(p));
}

export async function qualityApplyStatusOp(
  ctx: OpContext,
): Promise<QualityLifecycleSnapshot & { ok: boolean; comments?: QualityCommentReadback; jiraMutated: boolean }> {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "quality apply status requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  const local = resolveLocalWorkPackage(repo, ctx.wp);
  const workPackageId = local?.id ?? ctx.wp;
  const run = async (provider?: Parameters<typeof collectQualityLifecycleSnapshot>[0]["provider"]) => {
    const lifecycle = await collectQualityLifecycleSnapshot({
      provider,
      repo,
      workPackageId,
      jiraIssueKey: resolveRemoteWpKey(repo, workPackageId),
    });
    let comments: Awaited<ReturnType<typeof inspectQualityComments>> | undefined;
    if (provider && lifecycle.jiraWorkPackageKey && lifecycle.reviewId != null) {
      comments = await inspectQualityComments({
        provider,
        issueKey: lifecycle.jiraWorkPackageKey,
        reviewId: lifecycle.reviewId,
      });
    }
    return {
      ok: lifecycle.overallConsistency === "consistent" && lifecycle.applyPartial !== true,
      ...lifecycle,
      comments,
      jiraMutated: false,
    };
  };
  if (!ctx.provider && !jiraConfigured()) return run();
  const jiraIssueKey = resolveRemoteWpKey(repo, workPackageId);
  if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(jiraIssueKey)) return run();
  return withProvider({ ...ctx, repo }, (p) => run(p));
}

export async function qualityReviewShowOp(ctx: OpContext) {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "quality review show requires workPackage");
  }
  if (ctx.reviewId == null) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "quality review show requires reviewId");
  }
  const repo = requireRepo(ctx.repo);
  const local = resolveLocalWorkPackage(repo, ctx.wp);
  const workPackageId = local?.id ?? ctx.wp;
  const { fetchQualityReview } = await import("./quality-lifecycle.js");
  return fetchQualityReview({ repo, workPackageId, reviewId: ctx.reviewId });
}

export async function qualityEnsureOp(ctx: OpContext) {
  const repo = requireRepo(ctx.repo);
  const { ensureQuality, QualityStartupError } = await import("./quality-ensure.js");
  try {
    return await ensureQuality({ repo });
  } catch (err) {
    if (err instanceof QualityStartupError) {
      throw new PraxisOpError(err.code as OpCode, err.message, {
        stage: err.stage,
        durationMs: err.durationMs,
        details: err.details,
      });
    }
    throw err;
  }
}

function mapQualityReviewError(err: unknown): never {
  if (err instanceof QualityApplyError) {
    const code = (err.code in OP_CODES ? err.code : OP_CODES.CONFLICT) as OpCode;
    throw new PraxisOpError(code, err.message, { details: err.details });
  }
  if (err instanceof Error && /QUALITY_/.test(err.message)) {
    const raw = err.message.match(/^(QUALITY_[A-Z_]+)/)?.[1];
    const code = (raw && raw in OP_CODES ? raw : OP_CODES.CONFLICT) as OpCode;
    throw new PraxisOpError(code, err.message);
  }
  throw err;
}

export async function qualityReviewOp(ctx: OpContext) {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "quality review requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  const local = resolveLocalWorkPackage(repo, ctx.wp);
  const workPackageId = local?.id ?? ctx.wp;
  try {
    const { runQualityWorkPackageReview } = await import("./quality-lifecycle.js");
    const { QualityStartupError } = await import("./quality-ensure.js");
    const { QualityReviewTransportError } = await import("./quality-lifecycle.js");
    try {
      const reviewed = await runQualityWorkPackageReview({
        repo,
        workPackageId,
        runtimeVersion: process.env.PRAXIS_BUNDLE_VERSION,
      });
      const qualityInputs = discoverQualityInputs(repo, workPackageId);
      return {
        ...reviewed,
        qualityInputs,
        jiraMutated: false,
        approvalApplied: false,
      };
    } catch (err) {
      if (err instanceof QualityStartupError) {
        throw new PraxisOpError(err.code as OpCode, err.message, {
          stage: err.stage,
          durationMs: err.durationMs,
          details: {
            ...(err.details ?? {}),
            verdict: "BLOCKED",
            blockedReason: "Quality Service unavailable",
          },
        });
      }
      if (err instanceof QualityReviewTransportError) {
        const code = (err.code in OP_CODES ? err.code : OP_CODES.EXTERNAL_SERVICE_ERROR) as OpCode;
        throw new PraxisOpError(code, err.message, { details: err.details });
      }
      throw err;
    }
  } catch (err) {
    mapQualityReviewError(err);
  }
}

export async function qualityApplyPreviewOp(ctx: OpContext) {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "quality apply preview requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  return withProvider({ ...ctx, repo }, async (p) => {
    try {
      const preview = await previewQualityApply({
        provider: p,
        repo,
        workPackageId: resolveLocalWorkPackage(repo, ctx.wp!)?.id ?? ctx.wp!,
        reviewId: ctx.reviewId,
      });
      return {
        ...preview,
        jiraMutated: false,
      };
    } catch (err) {
      mapQualityReviewError(err);
    }
  });
}

export async function qualityApplyOp(ctx: OpContext): Promise<QualityApplyResult & { jiraMutated: boolean }> {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "quality apply requires workPackage");
  }
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(
      OP_CODES.CONFIRMATION_REQUIRED,
      "quality apply requires previewFingerprint from the matching preview",
    );
  }
  const repo = requireRepo(ctx.repo);
  const workPackageId = resolveLocalWorkPackage(repo, ctx.wp)?.id ?? ctx.wp;
  return guardWrite(ctx, {
    what: "quality apply",
    action: "praxis_quality_apply",
    operation: "external_state_change",
    provider: "jira",
    repository: repo,
    workItemId: workPackageId,
    requireYes: true,
  }, () => withProvider({ ...ctx, repo }, async (p) => {
    try {
      const { markQualityReviewApplied } = await import("./quality-lifecycle.js");
      const { ensureQuality } = await import("./quality-ensure.js");
      const applied = await applyQualityReview({
        provider: p,
        repo,
        workPackageId,
        previewFingerprint: ctx.previewFingerprint!,
        syncQualityStore: async ({ reviewId, payload }) => {
          try {
            if (!process.env.PRAXIS_QUALITY_URL) {
              await ensureQuality({ repo });
            }
            return await markQualityReviewApplied({ repo, reviewId, payload });
          } catch (err) {
            return {
              ok: false as const,
              reason: err instanceof Error ? err.message : String(err),
            };
          }
        },
      });
      return { ...applied, jiraMutated: applied.completed.length > 0 };
    } catch (err) {
      mapQualityReviewError(err);
    }
  }));
}

function gitCtx(ctx: OpContext): GitOpContext {
  const repo = requireRepo(ctx.repo);
  const workPackageId = ctx.wp ? resolveLocalWorkPackage(repo, ctx.wp)?.id ?? ctx.wp : "";
  const resolved = ctx.wp ? resolveRemoteWpKey(repo, workPackageId) : undefined;
  const jiraKey =
    ctx.wp && /^[A-Z][A-Z0-9]+-\d+$/i.test(ctx.wp)
      ? ctx.wp
      : resolved && /^[A-Z][A-Z0-9]+-\d+$/i.test(resolved)
        ? resolved
        : undefined;
  return {
    repo,
    workPackageId,
    jiraWorkPackageKey: jiraKey,
    remoteName: ctx.remoteName,
    remoteUrl: ctx.remoteUrl,
    branch: ctx.branch,
    targetBranch: ctx.targetBranch,
    files: ctx.files,
    commitMessage: ctx.commitMessage,
    gitUserName: ctx.gitUserName,
    gitUserEmail: ctx.gitUserEmail,
    providerKind: ctx.providerKind,
    vcsProvider: ctx.vcsProvider,
    fetchImpl: ctx.vcsFetchImpl,
    confirmation: ctx.confirmation,
    previewFingerprint: ctx.previewFingerprint,
    gitPublishMode: ctx.gitPublishMode,
  };
}

function mapVcs(err: unknown): never {
  if (err instanceof VcsError) {
    const code = (OP_CODES as Record<string, OpCode>)[err.code] ?? OP_CODES.WORKFLOW_BLOCKED;
    throw new PraxisOpError(code, redact(err.message), { details: err.details });
  }
  throw err;
}

function requireGitWp(ctx: OpContext): void {
  if (!ctx.wp) throw new PraxisOpError(OP_CODES.INVALID_INPUT, "git delivery requires workPackage");
}

export async function developerGitStatusOp(ctx: OpContext) {
  requireGitWp(ctx);
  try {
    return await gitStatusData(gitCtx(ctx));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitConnectPreviewOp(ctx: OpContext) {
  requireGitWp(ctx);
  try {
    return gitConnectPreviewData(gitCtx(ctx));
  } catch (err) {
    mapVcs(err);
  }
}

// --- request descriptions for secure Git authorization -----------------------------------------------------
// Each one re-reads the live repository and refuses a stale preview, so what the owner is shown and what the
// token binds is exactly what would run now.

function staleGitPreview(): never {
  throw new PraxisOpError(OP_CODES.GIT_PREVIEW_STALE, "the Git preview is stale; run the preview again");
}

const describeConnect = (ctx: OpContext) => async (): Promise<GitDescribed> => {
  const p = gitConnectPreviewData(gitCtx(ctx));
  if (p.previewFingerprint !== ctx.previewFingerprint) staleGitPreview();
  return {
    instanceId: "local",
    targets: [`remote:${p.proposedRemoteName}`, `identity:${p.proposedIdentity}`, `url:${p.proposedUrlDisplay}`],
    revision: p.previewFingerprint,
    previewFingerprint: p.previewFingerprint,
    summary: `Set Git remote ${p.proposedRemoteName} to ${p.proposedIdentity}`,
    description: `Configure remote ${p.proposedRemoteName} as ${p.proposedUrlDisplay} (${p.proposedIdentity}). No push.`,
    risks: ["changes where this repository publishes to"],
  };
};

const describeIdentity = (ctx: OpContext) => async (): Promise<GitDescribed> => {
  const p = gitIdentityPreviewData(gitCtx(ctx));
  if (p.previewFingerprint !== ctx.previewFingerprint) staleGitPreview();
  return {
    instanceId: "local",
    targets: [`git-user:${p.proposedName ?? ""} <${p.proposedEmail ?? ""}>`, "scope:local"],
    revision: p.previewFingerprint,
    previewFingerprint: p.previewFingerprint,
    summary: "Set the repository-local Git author identity",
    description: `Set user.name=${p.proposedName ?? "(unchanged)"} and user.email=${p.proposedEmail ?? "(unchanged)"} in this repository only.`,
  };
};

const describeCommit = (ctx: OpContext) => async (): Promise<GitDescribed> => {
  const p = await gitPreviewData(gitCtx(ctx));
  if (p.previewFingerprint !== ctx.previewFingerprint) staleGitPreview();
  const files = p.fileHashes.map((f) => `${f.path}@${f.sha256 ?? "deleted"}`);
  return {
    instanceId: "local",
    targets: [`branch:${p.branch}`, ...files],
    revision: p.headSha ?? "unborn",
    previewFingerprint: p.previewFingerprint,
    summary: `Commit ${files.length} file(s) to branch ${p.branch}`,
    description: `Commit on branch ${p.branch} from HEAD ${p.headSha ?? "(none)"} with message "${p.commitMessage}". Files: ${files.join(", ") || "(none)"}.`,
    risks: ["creates a commit; does not push"],
    branch: p.branch,
  };
};

const describePublish = (ctx: OpContext) => async (): Promise<GitDescribed> => {
  const p = await gitPublishPreviewData(gitCtx(ctx));
  if (p.previewFingerprint !== ctx.previewFingerprint) staleGitPreview();
  return {
    instanceId: p.remoteIdentity,
    targets: [`refspec:${p.refspec}`, `remote:${p.remoteName}`, `mode:${p.mode}`],
    revision: p.sourceCommitSha,
    previewFingerprint: p.previewFingerprint,
    summary: `Push ${p.sourceBranch} to ${p.remoteIdentity} (${p.targetRemoteBranch})`,
    description: `Push ${p.refspec} to remote ${p.remoteName} (${p.remoteIdentity}), mode ${p.mode}. Never forced.`,
    risks: ["publishes commits to a remote"],
    branch: p.sourceBranch,
    remote: p.remoteIdentity,
  };
};

const describeMergeRequest = (ctx: OpContext) => async (): Promise<GitDescribed> => {
  const m = await gitMergeRequestPreviewData(gitCtx(ctx));
  if (m.previewFingerprint !== ctx.previewFingerprint) staleGitPreview();
  return {
    instanceId: m.remoteIdentity,
    targets: [`merge-request:${m.sourceBranch}->${m.targetBranch}`],
    revision: m.commitSha,
    previewFingerprint: m.previewFingerprint,
    summary: `Open a merge request ${m.sourceBranch} -> ${m.targetBranch} on ${m.remoteIdentity}`,
    description: `Open a merge or pull request from ${m.sourceBranch} (commit ${m.commitSha}) into ${m.targetBranch} on ${m.remoteIdentity}. It is not merged.`,
    risks: ["creates a review request on the hosting provider"],
    remote: m.remoteIdentity,
  };
};

export async function developerGitConnectApplyOp(ctx: OpContext) {
  requireGitWp(ctx);
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git connect requires previewFingerprint");
  }
  const repo = requireRepo(ctx.repo);
  try {
    return await guardWrite(ctx, {
      what: "git connect",
      action: "praxis_developer_git_connect_apply",
      operation: "repository_edit",
      provider: "local",
      repository: repo,
      workItemId: ctx.wp,
      requireYes: true,
      git: { describe: describeConnect(ctx) },
    }, () => gitConnectApplyData(gitCtx(ctx)));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitIdentityPreviewOp(ctx: OpContext) {
  requireGitWp(ctx);
  try {
    return gitIdentityPreviewData(gitCtx(ctx));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitIdentityApplyOp(ctx: OpContext) {
  requireGitWp(ctx);
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git identity requires previewFingerprint");
  }
  const repo = requireRepo(ctx.repo);
  try {
    return await guardWrite(ctx, {
      what: "git identity",
      action: "praxis_developer_git_identity_apply",
      operation: "repository_edit",
      provider: "local",
      repository: repo,
      workItemId: ctx.wp,
      requireYes: true,
      git: { describe: describeIdentity(ctx) },
    }, () => gitIdentityApplyData(gitCtx(ctx)));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitPreviewOp(ctx: OpContext) {
  requireGitWp(ctx);
  try {
    return await gitPreviewData(gitCtx(ctx));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitCommitOp(ctx: OpContext): Promise<GitDeliveryJournal & GitWriteFields> {
  requireGitWp(ctx);
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git commit requires previewFingerprint");
  }
  const repo = requireRepo(ctx.repo);
  try {
    return await guardWrite(ctx, {
      what: "git commit",
      action: "praxis_developer_git_commit",
      operation: "git_commit",
      provider: "local",
      repository: repo,
      workItemId: ctx.wp,
      requireYes: true,
      git: { describe: describeCommit(ctx) },
    }, () => gitCommitData(gitCtx(ctx)));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitPublishPreviewOp(ctx: OpContext) {
  requireGitWp(ctx);
  try {
    return await gitPublishPreviewData(gitCtx(ctx));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitPublishOp(ctx: OpContext): Promise<GitDeliveryJournal & GitWriteFields> {
  requireGitWp(ctx);
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git publish requires previewFingerprint");
  }
  const repo = requireRepo(ctx.repo);
  try {
    return await guardWrite(ctx, {
      what: "git publish",
      action: "praxis_developer_git_publish",
      operation: "git_push",
      provider: "local",
      repository: repo,
      workItemId: ctx.wp,
      requireYes: true,
      git: { describe: describePublish(ctx) },
    }, () => gitPublishData(gitCtx(ctx)));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitMergeRequestPreviewOp(ctx: OpContext) {
  requireGitWp(ctx);
  try {
    return await gitMergeRequestPreviewData(gitCtx(ctx));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitMergeRequestOp(ctx: OpContext): Promise<GitDeliveryJournal & GitWriteFields> {
  requireGitWp(ctx);
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git merge request requires previewFingerprint");
  }
  const repo = requireRepo(ctx.repo);
  try {
    return await guardWrite(ctx, {
      what: "git merge request",
      action: "praxis_developer_git_merge_request",
      operation: "merge_request",
      provider: "local",
      repository: repo,
      workItemId: ctx.wp,
      requireYes: true,
      git: { describe: describeMergeRequest(ctx) },
    }, () => gitMergeRequestData(gitCtx(ctx)));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitDeliveryStatusOp(ctx: OpContext) {
  requireGitWp(ctx);
  try {
    return gitDeliveryStatusData(gitCtx(ctx));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitLinkJiraPreviewOp(ctx: OpContext) {
  requireGitWp(ctx);
  const data = gitDeliveryStatusData(gitCtx(ctx));
  const url = data.journal?.mergeRequestUrl;
  const key = data.journal?.jiraWorkPackageKey;
  return {
    jiraIssueKey: key ?? null,
    mergeRequestUrl: url ?? null,
    proposedComment: url && key ? `Praxis Git Delivery: ${url}` : null,
    transitions: [],
    qualityApply: false,
    previewFingerprint: previewFingerprint({ key, url, comment: true }),
    jiraMutated: false as const,
  };
}

export async function developerGitLinkJiraApplyOp(ctx: OpContext) {
  requireGitWp(ctx);
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git link jira requires previewFingerprint");
  }
  const repo = requireRepo(ctx.repo);
  const preview = await developerGitLinkJiraPreviewOp(ctx);
  if (preview.previewFingerprint !== ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.GIT_PREVIEW_STALE, "git link jira previewFingerprint mismatch");
  }
  if (!preview.jiraIssueKey || !preview.proposedComment) {
    throw new PraxisOpError(OP_CODES.GIT_PUSH_BLOCKED, "No merge/pull request URL to link");
  }
  return guardWrite(ctx, {
    what: "git link jira",
    action: "praxis_developer_git_link_jira_apply",
    operation: "external_record_update",
    provider: "jira",
    repository: repo,
    workItemId: ctx.wp,
    requireYes: true,
  }, () => withProvider(ctx, async (p) => {
    await p.addComment(preview.jiraIssueKey!, preview.proposedComment!);
    return {
      jiraMutated: true,
      issueKey: preview.jiraIssueKey,
      comment: preview.proposedComment,
      transitioned: false,
      qualityApply: false,
    };
  }));
}
