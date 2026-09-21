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
import { VcsError, githubTokenFlags, gitlabTokenFlags } from "@praxis/vcs";
import {
  gitCommitData,
  gitConnectApplyData,
  gitConnectPreviewData,
  gitDeliveryStatusData,
  gitIdentityApplyData,
  gitIdentityPreviewData,
  gitMergeRequestData,
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
  GITLAB_TOKEN_UNAVAILABLE: "GITLAB_TOKEN_UNAVAILABLE",
  GIT_TRANSPORT_FAILED: "GIT_TRANSPORT_FAILED",
  GIT_COMMIT_DIVERGED: "GIT_COMMIT_DIVERGED",
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
};

export function loadPraxisDotenv(repo: string): void {
  if (process.env.PRAXIS_SKIP_DOTENV === "1") return;
  const resolved = resolve(repo);
  if (!existsSync(resolved)) return;
  for (const f of [".env.praxis", ".env", ".env.praxis.local"]) {
    const p = join(resolved, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m || process.env[m[1]!]) continue;
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

export async function doctorOp(ctx: OpContext, version: string) {
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
    github: githubTokenFlags(),
    gitlab: gitlabTokenFlags(),
    quality,
    capabilities,
    codes: {
      repository:
        capabilities.repository === "unavailable" ? OP_CODES.REPOSITORY_UNAVAILABLE : undefined,
      jira: capabilities.jiraConfig === "unavailable" ? OP_CODES.JIRA_CONFIG_UNAVAILABLE : undefined,
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
  requireConfirm(ctx.confirmation, "project init");
  const repo = requireRepo(ctx.repo);
  const inferred = inferProjectConfig(repo);
  if (inferred.existing.status === "loaded") {
    return {
      wrote: false,
      reason: "already-exists",
      path: inferred.existing.path,
    };
  }
  const path = writeProjectConfig(repo, inferred.yaml);
  return { wrote: true, path, config: inferred.proposed };
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
  requireConfirm(ctx.confirmation, "ba apply");
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "ba apply requires epic");
  }
  const repo = requireRepo(ctx.repo);
  return withProvider({ ...ctx, repo }, async (p) => {
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
  });
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
  requireConfirm(ctx.confirmation, "architect apply");
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "architect apply requires epic");
  }
  const repo = requireRepo(ctx.repo);
  return withProvider({ ...ctx, repo }, async (p) => {
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
  });
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
  jiraIssueKey: unknown;
}> {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "work-package show requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  const local = resolveLocalWorkPackage(repo, ctx.wp);
  if (!local) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, `work package not found: ${ctx.wp}`);
  }
  return {
    local,
    jiraIssueKey: resolveRemoteWpKey(repo, ctx.wp),
  };
}

export async function developerStatusOp(ctx: OpContext): Promise<Record<string, unknown>> {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer status requires workPackage");
  }
  const wp = ctx.wp;
  const repo = requireRepo(ctx.repo);
  const local = resolveLocalWorkPackage(repo, wp);
  const jiraIssueKey = resolveRemoteWpKey(repo, wp);
  const wpId = local?.id ?? wp;
  const inspection = inspectDeveloperCompletion(repo, wpId);
  const qualityInputs = discoverQualityInputs(repo, wpId);
  const base = {
    wp,
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
      jiraIssueKey,
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
  if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(jiraIssueKey)) {
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
  return withProvider({ ...ctx, repo }, async (p) => {
    const user = await p.getCurrentUser();
    return claimWorkPackage({
      provider: p,
      wpKey: ctx.wp!,
      repo,
      actor: ctx.actor ?? user.displayName ?? "developer",
      accountId: user.accountId,
    });
  });
}

export async function developerReleaseOp(ctx: OpContext) {
  requireConfirm(ctx.confirmation, "developer release");
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer release requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  return withProvider({ ...ctx, repo }, async (p) => {
    await releaseWorkPackage({
      provider: p,
      wpKey: resolveRemoteWpKey(repo, ctx.wp!),
      confirm: true,
    });
    return { released: true, wp: ctx.wp };
  });
}

export async function developerCompleteOp(ctx: OpContext): Promise<DeveloperCompleteResult> {
  requireConfirm(ctx.confirmation, "developer complete");
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer complete requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  const wp = ctx.wp;
  return withProvider({ ...ctx, repo }, (p) =>
    developerCompleteWp({
      provider: p,
      wpKey: wp,
      repo,
    }),
  );
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
  requireConfirm(ctx.confirmation, "developer complete recovery");
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
  return withProvider({ ...ctx, repo }, (p) =>
    applyDeveloperCompleteRecovery({
      provider: p,
      wpKey: wp,
      repo,
      previewFingerprint,
    }),
  );
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
  requireConfirm(ctx.confirmation, "quality apply");
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(
      OP_CODES.CONFIRMATION_REQUIRED,
      "quality apply requires previewFingerprint from the matching preview",
    );
  }
  const repo = requireRepo(ctx.repo);
  const workPackageId = resolveLocalWorkPackage(repo, ctx.wp)?.id ?? ctx.wp;
  return withProvider({ ...ctx, repo }, async (p) => {
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
  });
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

export async function developerGitConnectApplyOp(ctx: OpContext) {
  requireGitWp(ctx);
  requireConfirm(ctx.confirmation, "git connect");
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git connect requires previewFingerprint");
  }
  try {
    return gitConnectApplyData(gitCtx(ctx));
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
  requireConfirm(ctx.confirmation, "git identity");
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git identity requires previewFingerprint");
  }
  try {
    return gitIdentityApplyData(gitCtx(ctx));
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

export async function developerGitCommitOp(ctx: OpContext) {
  requireGitWp(ctx);
  requireConfirm(ctx.confirmation, "git commit");
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git commit requires previewFingerprint");
  }
  try {
    return await gitCommitData(gitCtx(ctx));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitPublishPreviewOp(ctx: OpContext) {
  requireGitWp(ctx);
  try {
    return gitPublishPreviewData(gitCtx(ctx));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitPublishOp(ctx: OpContext) {
  requireGitWp(ctx);
  requireConfirm(ctx.confirmation, "git publish");
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git publish requires previewFingerprint");
  }
  try {
    return await gitPublishData(gitCtx(ctx));
  } catch (err) {
    mapVcs(err);
  }
}

export async function developerGitMergeRequestOp(ctx: OpContext) {
  requireGitWp(ctx);
  requireConfirm(ctx.confirmation, "git merge request");
  try {
    return await gitMergeRequestData(gitCtx(ctx));
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
  requireConfirm(ctx.confirmation, "git link jira");
  if (!ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.CONFIRMATION_REQUIRED, "git link jira requires previewFingerprint");
  }
  const preview = await developerGitLinkJiraPreviewOp(ctx);
  if (preview.previewFingerprint !== ctx.previewFingerprint) {
    throw new PraxisOpError(OP_CODES.GIT_PREVIEW_STALE, "git link jira previewFingerprint mismatch");
  }
  if (!preview.jiraIssueKey || !preview.proposedComment) {
    throw new PraxisOpError(OP_CODES.GIT_PUSH_BLOCKED, "No merge/pull request URL to link");
  }
  return withProvider(ctx, async (p) => {
    await p.addComment(preview.jiraIssueKey!, preview.proposedComment);
    return {
      jiraMutated: true,
      issueKey: preview.jiraIssueKey,
      comment: preview.proposedComment,
      transitioned: false,
      qualityApply: false,
    };
  });
}
