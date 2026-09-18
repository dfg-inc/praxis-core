import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  inferProjectConfig,
  loadProjectConfig,
  writeProjectConfig,
} from "@praxis/project-config";
import { createJiraProvider, loadJiraConfig, type JiraProvider } from "@praxis/jira";
import {
  architectPlanEpic,
  baAnalyzeEpic,
  claimWorkPackage,
  collectEpicStatus,
  developerCompleteWp,
  discoverLocalWorkPackages,
  qaVerifyWorkPackage,
  releaseWorkPackage,
  resolveLocalWorkPackage,
  resolveRemoteWpKey,
} from "@praxis/jira/workflow";
import { ensureQuality } from "./quality-ensure.js";

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
} as const;

export type OpCode = (typeof OP_CODES)[keyof typeof OP_CODES];

export class PraxisOpError extends Error {
  readonly code: OpCode;
  constructor(code: OpCode, message: string) {
    super(message);
    this.name = "PraxisOpError";
    this.code = code;
  }
}

export function previewFingerprint(plan: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(plan ?? null)).digest("hex")}`;
}

export function redact(text: string): string {
  return text
    .replace(/PRAXIS_JIRA_TOKEN=\S+/g, "PRAXIS_JIRA_TOKEN=<redacted>")
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

async function withProvider<T>(
  ctx: OpContext,
  fn: (p: JiraProvider) => Promise<T>,
): Promise<T> {
  if (ctx.provider) return fn(ctx.provider);
  if (!jiraConfigured()) {
    throw new PraxisOpError(OP_CODES.JIRA_CONFIG_UNAVAILABLE, jiraConfigUnavailableMessage());
  }
  try {
    const config = loadJiraConfig();
    return await fn(createJiraProvider({ config }));
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e));
    if (e instanceof PraxisOpError) throw e;
    throw new PraxisOpError(OP_CODES.EXTERNAL_SERVICE_ERROR, msg);
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
  const qualityUrl = process.env.PRAXIS_QUALITY_URL || "http://127.0.0.1:8792/health";
  let quality = { healthy: false, url: qualityUrl };
  try {
    const r = await fetch(qualityUrl);
    quality = { healthy: r.ok, url: qualityUrl };
  } catch {
    quality = { healthy: false, url: qualityUrl };
  }
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
  return withProvider({ ...ctx, repo }, async (p) => {
    const result = await baAnalyzeEpic({
      provider: p,
      epicKey: ctx.epic!,
      repo,
      dryRun: true,
    });
    return { ...result, previewFingerprint: previewFingerprint(result.plan) };
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

export async function architectPreviewOp(ctx: OpContext) {
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "architect preview requires epic");
  }
  const repo = requireRepo(ctx.repo);
  return withProvider({ ...ctx, repo }, async (p) => {
    const result = await architectPlanEpic({
      provider: p,
      epicKey: ctx.epic!,
      repo,
      dryRun: true,
    });
    return { ...result, previewFingerprint: previewFingerprint(result.plan) };
  });
}

export async function architectApplyOp(ctx: OpContext) {
  requireConfirm(ctx.confirmation, "architect apply");
  if (!ctx.epic) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "architect apply requires epic");
  }
  const repo = requireRepo(ctx.repo);
  return withProvider({ ...ctx, repo }, async (p) => {
    const preview = await architectPlanEpic({
      provider: p,
      epicKey: ctx.epic!,
      repo,
      dryRun: true,
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
    });
    return { ...result, previewFingerprint: previewFingerprint(result.plan) };
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

export async function developerStatusOp(ctx: OpContext) {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer status requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  const local = resolveLocalWorkPackage(repo, ctx.wp);
  return {
    wp: ctx.wp,
    local: local?.id,
    jiraIssueKey: resolveRemoteWpKey(repo, ctx.wp),
  };
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

export async function developerCompleteOp(ctx: OpContext) {
  requireConfirm(ctx.confirmation, "developer complete");
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "developer complete requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  return withProvider({ ...ctx, repo }, async (p) => {
    await developerCompleteWp({
      provider: p,
      wpKey: ctx.wp!,
      repo,
      evidence: { verification: { ok: true } },
    });
    return { completed: true, wp: ctx.wp };
  });
}

export async function qualityStatusOp(ctx: OpContext) {
  const repo = requireRepo(ctx.repo);
  return ensureQuality({ repo });
}

export async function qualityEnsureOp(ctx: OpContext) {
  const repo = requireRepo(ctx.repo);
  const ensured = await ensureQuality({ repo });
  if (ensured.status === "unavailable") {
    throw new PraxisOpError(
      OP_CODES.WORKFLOW_BLOCKED,
      "workflow blocked: Quality service unavailable",
    );
  }
  return ensured;
}

export async function qualityReviewOp(ctx: OpContext) {
  if (!ctx.wp) {
    throw new PraxisOpError(OP_CODES.INVALID_INPUT, "quality review requires workPackage");
  }
  const repo = requireRepo(ctx.repo);
  return withProvider({ ...ctx, repo }, (p) =>
    qaVerifyWorkPackage({
      provider: p,
      wpKey: ctx.wp!,
      repo,
    }),
  );
}
