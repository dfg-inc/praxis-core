import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Worker } from "node:worker_threads";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_QUALITY_PORT = 8792;
export const QUALITY_STARTUP_BUDGET_MS = 15_000;

export const QUALITY_CODES = {
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
} as const;

export type QualityErrorCode = (typeof QUALITY_CODES)[keyof typeof QUALITY_CODES];

export type QualityProbeStatus =
  | "not_started"
  | "starting"
  | "healthy"
  | "unavailable"
  | "failed"
  | "stopped"
  | "unknown";

export type QualityEnsureResult = {
  status: "healthy" | "started" | QualityProbeStatus;
  pid?: number;
  url: string;
  db?: string;
  reused: boolean;
  durationMs?: number;
  logPath?: string;
  executable?: string;
  cwd?: string;
  port?: number;
  runtimeMode?: "process" | "worker";
  sqliteBackend?: string;
  lastKnownPid?: number;
  lastHealthyAt?: string;
  lastExitCode?: number | null;
  lastExitSignal?: string | null;
  lastExitAt?: string;
  diagnostic?: string;
};

type QualityStateFile = {
  pid?: number;
  port?: number;
  url?: string;
  db?: string;
  allowedRoot?: string;
  startedAt?: string;
  runtimeMode?: "process" | "worker";
  lastHealthyAt?: string;
  lastKnownPid?: number;
  lastExitCode?: number | null;
  lastExitSignal?: string | null;
  lastExitAt?: string;
};

type HealthBody = {
  ok?: boolean;
  service?: string;
  allowedRoot?: string | null;
  db?: string | null;
  pid?: number;
  port?: number;
  sqliteEngine?: string | null;
};

export type SqliteModuleLoad = "success" | "failure";

export type NodeRuntimeProbe = {
  execPath: string;
  version: string;
  versionsNode: string;
  platform: string;
  arch: string;
  electron?: string;
  moduleLoad: SqliteModuleLoad;
  errorCode?: string;
  errorMessage?: string;
  spawnStatus?: number | null;
  spawnError?: string;
};

export type QualityRuntimeMode = "process" | "worker";

export type QualityChildRuntime = {
  mode: QualityRuntimeMode;
  execPath: string;
  extraArgs: string[];
  extraEnv: Record<string, string>;
  parent: NodeRuntimeProbe;
  child: NodeRuntimeProbe;
};

const inFlight = new Map<string, Promise<QualityEnsureResult>>();
const workers = new Map<string, Worker>();

export class QualityStartupError extends Error {
  readonly code: QualityErrorCode;
  readonly stage: string;
  readonly durationMs: number;
  readonly details: Record<string, unknown>;
  constructor(
    code: QualityErrorCode,
    message: string,
    extra: {
      stage: string;
      durationMs: number;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "QualityStartupError";
    this.code = code;
    this.stage = extra.stage;
    this.durationMs = extra.durationMs;
    this.details = extra.details ?? {};
  }
}

function qlog(msg: string): void {
  process.stderr.write(`[praxis-quality] ${msg}\n`);
}

function safeErrorMessage(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  return text
    .replace(/PRAXIS_JIRA_TOKEN=\S+/g, "PRAXIS_JIRA_TOKEN=<redacted>")
    .replace(/Authorization:\s*\S+/gi, "Authorization=<redacted>")
    .replace(/Bearer\s+\S+/g, "Bearer <redacted>")
    .slice(0, 240);
}

function safeLogTail(logFile: string): string {
  if (!existsSync(logFile)) return "";
  return readFileSync(logFile, "utf8")
    .replace(/PRAXIS_JIRA_TOKEN=\S+/g, "PRAXIS_JIRA_TOKEN=<redacted>")
    .replace(/Authorization:\s*\S+/gi, "Authorization=<redacted>")
    .replace(/Bearer\s+\S+/g, "Bearer <redacted>")
    .slice(-1500);
}
function looksLikeElectronBinary(execPath: string, electronVersion?: string): boolean {
  if (electronVersion) return true;
  const base = basename(execPath).toLowerCase();
  return (
    base.includes("electron") ||
    base.includes("claude") ||
    /claude\.app\/contents\/macos\//i.test(execPath)
  );
}

export function isNodeCliExecutable(execPath: string): boolean {
  const base = basename(execPath).replace(/\.exe$/i, "").toLowerCase();
  return base === "node" || base === "nodejs";
}

export function isElectronHelperExecutable(execPath: string): boolean {
  const normalized = execPath.replace(/\\/g, "/");
  if (/Helper[^/]*\.app\/Contents\/MacOS\//i.test(normalized)) return true;
  if (/\/Contents\/Frameworks\/[^/]*Helper/i.test(normalized)) return true;
  if (looksLikeElectronBinary(execPath, process.versions.electron) && !isNodeCliExecutable(execPath)) {
    return true;
  }
  return false;
}

export function parentExecPath(): string {
  const simulated = process.env.PRAXIS_QUALITY_SIMULATED_EXEC_PATH;
  if (simulated && simulated.trim()) return simulated;
  return process.execPath;
}

export type SpawnWaitResult = {
  spawned: boolean;
  pid?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
};

export function spawnErrorFields(err: NodeJS.ErrnoException | undefined): Record<string, unknown> {
  if (!err) return {};
  const extra = err as NodeJS.ErrnoException & { spawnargs?: string[] };
  return {
    spawnErrorCode: extra.code,
    spawnErrno: extra.errno,
    spawnSyscall: extra.syscall,
    spawnPath: extra.path ? safeErrorMessage(extra.path) : undefined,
    spawnArgs: Array.isArray(extra.spawnargs)
      ? extra.spawnargs.map((arg) => safeErrorMessage(arg))
      : undefined,
    spawnErrorMessage: safeErrorMessage(extra.message),
  };
}

export function classifySpawnFailure(err: NodeJS.ErrnoException | undefined): QualityErrorCode {
  const code = err?.code;
  if (code === "ENOENT") return QUALITY_CODES.QUALITY_EXECUTABLE_NOT_FOUND;
  if (code === "EACCES" || code === "EPERM") return QUALITY_CODES.QUALITY_EXECUTABLE_NOT_PERMITTED;
  return QUALITY_CODES.QUALITY_SPAWN_FAILED;
}

export function waitForChildStart(child: ChildProcess, timeoutMs = 1500): Promise<SpawnWaitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SpawnWaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.off("exit", onExit);
      resolve(result);
    };
    const onSpawn = () => finish({ spawned: true, pid: child.pid });
    const onError = (err: NodeJS.ErrnoException) =>
      finish({ spawned: false, pid: child.pid, error: err });
    const onExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null) =>
      finish({
        spawned: Boolean(child.pid),
        pid: child.pid,
        exitCode,
        exitSignal,
      });
    const timer = setTimeout(() => {
      if (child.pid && child.exitCode === null) {
        finish({ spawned: true, pid: child.pid });
        return;
      }
      const err = Object.assign(new Error("Quality child spawn timed out before pid/error"), {
        code: "ETIMEDOUT",
      }) as NodeJS.ErrnoException;
      finish({ spawned: false, pid: child.pid, error: err });
    }, timeoutMs);
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.pid && child.exitCode === null) {
      queueMicrotask(() => {
        if (!settled && child.pid && child.exitCode === null) {
          finish({ spawned: true, pid: child.pid });
        }
      });
    }
  });
}

function repoKey(repo: string): string {
  const abs = resolve(repo);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function qualityDir(repo: string): string {
  return join(repoKey(repo), ".praxis-quality");
}

export function qualityStatePath(repo: string): string {
  return join(qualityDir(repo), "quality.json");
}

export function qualityPidPath(repo: string): string {
  return join(qualityDir(repo), "quality.pid");
}

export function qualityDbPath(repo: string): string {
  return process.env.PRAXIS_QUALITY_DB ?? join(qualityDir(repo), "quality.sqlite");
}

export function qualityLogPath(repo: string): string {
  return join(qualityDir(repo), "quality.log");
}

function startupTimeoutMs(): number {
  const raw = Number(process.env.PRAXIS_QUALITY_STARTUP_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 200) {
    return Math.min(Math.floor(raw), QUALITY_STARTUP_BUDGET_MS);
  }
  return QUALITY_STARTUP_BUDGET_MS;
}

function configuredPort(): number {
  const fromEnv = Number(process.env.PRAXIS_QUALITY_PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  const url = process.env.PRAXIS_QUALITY_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.port) return Number(parsed.port);
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_QUALITY_PORT;
}

function urlForPort(port: number): string {
  if (process.env.PRAXIS_QUALITY_URL) return process.env.PRAXIS_QUALITY_URL;
  return `http://127.0.0.1:${port}/health`;
}

function readState(repo: string): QualityStateFile | undefined {
  const p = qualityStatePath(repo);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as QualityStateFile;
  } catch {
    return undefined;
  }
}

function writeState(repo: string, state: QualityStateFile): void {
  mkdirSync(qualityDir(repo), { recursive: true });
  writeFileSync(qualityStatePath(repo), `${JSON.stringify(state, null, 2)}\n`);
  if (state.pid) writeFileSync(qualityPidPath(repo), `${state.pid}\n`);
}

function patchState(repo: string, patch: Partial<QualityStateFile>): void {
  const prev = readState(repo) ?? {};
  writeState(repo, { ...prev, ...patch });
}

function appendSupervisorLog(repo: string, line: string): void {
  try {
    const p = qualityLogPath(repo);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      `[praxis-quality-supervisor] ${new Date().toISOString()} ${line}\n`,
      { flag: "a" },
    );
  } catch {
    /* best-effort */
  }
}

let supervisorHooksInstalled = false;
function installSupervisorHooks(): void {
  if (supervisorHooksInstalled) return;
  supervisorHooksInstalled = true;
  const persist = (reason: string) => {
    for (const [key] of workers) {
      appendSupervisorLog(key, `quality.supervisor ${reason} pid=${process.pid}`);
      try {
        patchState(key, {
          lastKnownPid: process.pid,
          lastExitAt: new Date().toISOString(),
          lastExitSignal: reason.includes("SIG") ? reason.replace(/^.*SIG/, "SIG") : null,
        });
      } catch {
        /* ignore */
      }
    }
  };
  process.on("exit", () => persist("host exit"));
  process.on("SIGTERM", () => persist("received signal SIGTERM"));
  process.on("SIGINT", () => persist("received signal SIGINT"));
}

function isAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
}

export function stopQuality(repo: string): void {
  const key = repoKey(repo);
  const state = readState(repo);
  const worker = workers.get(key);
  if (worker || state?.runtimeMode === "worker") {
    const port = state?.port ?? configuredPort();
    const url = `http://127.0.0.1:${port}/shutdown`;
    void fetch(url, { method: "POST", signal: AbortSignal.timeout(400) }).catch(() => undefined);
    const started = Date.now();
    while (Date.now() - started < 250) {
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 50);
    }
    if (worker) {
      try {
        void worker.terminate();
      } catch {
        /* ignore */
      }
      workers.delete(key);
    }
    return;
  }
  const pid = state?.pid;
  if (pid && isAlive(pid)) killPid(pid);
  const started = Date.now();
  while (pid && isAlive(pid) && Date.now() - started < 2000) {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, 50);
  }
  if (pid && isAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

async function fetchHealth(url: string, timeoutMs = 800): Promise<HealthBody | undefined> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return undefined;
    const body = (await r.json()) as HealthBody;
    if (body && body.ok === true) return body;
    return undefined;
  } catch {
    return undefined;
  }
}

function rootsMatch(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  return repoKey(a) === repoKey(b);
}

export function resolveQualityExecutable(): string | undefined {
  const override = process.env.PRAXIS_QUALITY_ENTRY;
  if (override) return isAbsolute(override) ? override : resolve(override);

  const argvDir = process.argv[1] ? dirname(resolve(process.argv[1])) : undefined;
  if (argvDir) {
    const sibling = join(argvDir, "praxis-quality.cjs");
    if (existsSync(sibling)) return sibling;
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const bundled = join(here, "praxis-quality.cjs");
    if (existsSync(bundled)) return bundled;
  } catch {
    /* ignore */
  }

  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("@praxis/quality-service/package.json");
    const entry = join(dirname(pkg), "dist", "main.js");
    if (existsSync(entry)) return entry;
  } catch {
    /* ignore */
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const monorepo = resolve(here, "../../../apps/quality-service/dist/main.js");
    if (existsSync(monorepo)) return monorepo;
  } catch {
    /* ignore */
  }

  return undefined;
}

const SQLITE_PROBE_SOURCE = `
try {
  require('node:sqlite');
  process.stdout.write(JSON.stringify({
    ok: true,
    version: process.version,
    versionsNode: process.versions.node,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron || null
  }));
} catch (e) {
  process.stdout.write(JSON.stringify({
    ok: false,
    version: process.version,
    versionsNode: process.versions.node,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron || null,
    code: e && e.code ? String(e.code) : undefined,
    message: e && e.message ? String(e.message) : String(e)
  }));
  process.exitCode = 2;
}
`;

function parseProbeJson(stdout: string | undefined): {
  ok?: boolean;
  version?: string;
  versionsNode?: string;
  execPath?: string;
  platform?: string;
  arch?: string;
  electron?: string | null;
  code?: string;
  message?: string;
} | undefined {
  const text = (stdout ?? "").trim();
  if (!text) return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as {
      ok?: boolean;
      version?: string;
      versionsNode?: string;
      execPath?: string;
      platform?: string;
      arch?: string;
      electron?: string | null;
      code?: string;
      message?: string;
    };
  } catch {
    return undefined;
  }
}

export function probeSqliteInProcess(): NodeRuntimeProbe {
  let moduleLoad: SqliteModuleLoad = "failure";
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  try {
    const req = createRequire(import.meta.url);
    req("node:sqlite");
    moduleLoad = "success";
  } catch (err) {
    const e = err as { code?: string; message?: string };
    errorCode = e.code;
    errorMessage = safeErrorMessage(e.message);
  }
  return {
    execPath: process.execPath,
    version: process.version,
    versionsNode: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    moduleLoad,
    errorCode,
    errorMessage,
  };
}

export function probeSqliteWithExecutable(
  execPath: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): NodeRuntimeProbe {
  const r = spawnSync(execPath, [...extraArgs, "-e", SQLITE_PROBE_SOURCE], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, ...extraEnv },
  });
  const parsed = parseProbeJson(r.stdout);
  const spawnError = r.error ? safeErrorMessage(r.error.message) : undefined;
  const moduleLoad: SqliteModuleLoad = parsed?.ok === true && (r.status ?? 1) === 0 ? "success" : "failure";
  return {
    execPath: parsed?.execPath || execPath,
    version: parsed?.version || "",
    versionsNode: parsed?.versionsNode || "",
    platform: parsed?.platform || process.platform,
    arch: parsed?.arch || process.arch,
    electron: parsed?.electron || (extraEnv.ELECTRON_RUN_AS_NODE ? process.versions.electron : undefined),
    moduleLoad,
    errorCode: parsed?.code || (spawnError ? "SPAWN_FAILED" : undefined),
    errorMessage: safeErrorMessage(parsed?.message || spawnError || r.stderr),
    spawnStatus: r.status,
    spawnError,
  };
}

export function classifySqliteProbeError(probe: NodeRuntimeProbe): QualityErrorCode {
  const code = probe.errorCode ?? "";
  const msg = (probe.errorMessage ?? "").toLowerCase();
  if (code === "ERR_UNKNOWN_BUILTIN_MODULE" || msg.includes("node:sqlite")) {
    return QUALITY_CODES.QUALITY_SQLITE_UNAVAILABLE;
  }
  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
    return QUALITY_CODES.QUALITY_SQLITE_MODULE_LOAD_FAILED;
  }
  if (code === "SPAWN_FAILED") {
    return QUALITY_CODES.QUALITY_CHILD_RUNTIME_MISMATCH;
  }
  return QUALITY_CODES.QUALITY_SQLITE_MODULE_LOAD_FAILED;
}

export function resolveQualityChildRuntime(): QualityChildRuntime {
  const observedParent = parentExecPath();
  const parentProbe = probeSqliteInProcess();
  const parent: NodeRuntimeProbe = { ...parentProbe, execPath: observedParent };
  const extraArgs: string[] = [];
  const extraEnv: Record<string, string> = {};
  const override = process.env.PRAXIS_QUALITY_NODE?.trim();

  if (override) {
    if (isElectronHelperExecutable(override) || looksLikeElectronBinary(override)) {
      extraEnv.ELECTRON_RUN_AS_NODE = "1";
    }
    const child = probeSqliteWithExecutable(override, extraEnv, extraArgs);
    return { mode: "process", execPath: override, extraArgs, extraEnv, parent, child };
  }

  if (isElectronHelperExecutable(observedParent)) {
    qlog(
      `quality.node.resolve helper-execPath detected; using worker in the current MCP runtime instead of spawning ${basename(observedParent)}`,
    );
    return {
      mode: "worker",
      execPath: process.execPath,
      extraArgs,
      extraEnv,
      parent,
      child: {
        ...parentProbe,
        execPath: process.execPath,
      },
    };
  }

  if (process.versions.electron && !isNodeCliExecutable(process.execPath)) {
    extraEnv.ELECTRON_RUN_AS_NODE = "1";
  }

  const child = isNodeCliExecutable(process.execPath)
    ? probeSqliteWithExecutable(process.execPath, extraEnv, extraArgs)
    : parentProbe;
  return {
    mode: "process",
    execPath: process.execPath,
    extraArgs,
    extraEnv,
    parent,
    child,
  };
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolvePromise(true);
    });
    socket.on("error", () => resolvePromise(false));
    socket.setTimeout(300, () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

function waitForWorkerStart(worker: Worker, timeoutMs = 1500): Promise<SpawnWaitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SpawnWaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off("online", onOnline);
      worker.off("error", onError);
      worker.off("exit", onExit);
      resolve(result);
    };
    const onOnline = () => finish({ spawned: true, pid: process.pid });
    const onError = (err: Error) =>
      finish({ spawned: false, pid: process.pid, error: err as NodeJS.ErrnoException });
    const onExit = (exitCode: number) =>
      finish({ spawned: Boolean(process.pid), pid: process.pid, exitCode });
    const timer = setTimeout(() => {
      finish({ spawned: true, pid: process.pid });
    }, timeoutMs);
    worker.once("online", onOnline);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

function startQualityWorker(opts: {
  repo: string;
  entry: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
}): Worker {
  installSupervisorHooks();
  const key = repoKey(opts.repo);
  const existing = workers.get(key);
  if (existing) {
    try {
      void existing.terminate();
    } catch {
      /* ignore */
    }
    workers.delete(key);
  }
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const log = createWriteStream(opts.logPath, { flags: "a" });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, val] of Object.entries(opts.env)) {
    if (val !== undefined) env[key] = val;
  }
  const worker = new Worker(opts.entry, {
    stdout: true,
    stderr: true,
    execArgv: [],
    env,
  });
  worker.stdout?.on("data", (chunk: Buffer) => log.write(chunk));
  worker.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
  worker.on("exit", (code) => {
    const line = `quality.worker.exit code=${code ?? "none"} pid=${process.pid}`;
    try {
      log.write(`${line}\n`);
    } catch {
      /* ignore */
    }
    appendSupervisorLog(opts.repo, line);
    patchState(opts.repo, {
      lastKnownPid: process.pid,
      lastExitCode: code ?? null,
      lastExitAt: new Date().toISOString(),
    });
    log.end();
    if (workers.get(key) === worker) workers.delete(key);
  });
  worker.on("error", (err) => {
    const msg = `quality.worker error ${safeErrorMessage(err)}`;
    qlog(msg);
    appendSupervisorLog(opts.repo, msg);
  });
  workers.set(key, worker);
  return worker;
}

function fail(
  code: QualityErrorCode,
  message: string,
  stage: string,
  t0: number,
  details?: Record<string, unknown>,
): never {
  const durationMs = Date.now() - t0;
  qlog(`startup failed stage=${stage} errorCode=${code} durationMs=${durationMs}`);
  throw new QualityStartupError(code, message, {
    stage,
    durationMs,
    details: {
      ...details,
      errorCode: code,
      durationMs,
      safeMessage: message,
      stage,
    },
  });
}

export async function probeQuality(opts: { repo: string }): Promise<QualityEnsureResult> {
  const repo = repoKey(opts.repo);
  const state = existsSync(opts.repo) ? readState(repo) : undefined;
  const port = state?.port ?? configuredPort();
  const url = state?.url ?? urlForPort(port);
  const db = state?.db ?? (existsSync(opts.repo) ? qualityDbPath(repo) : undefined);
  const logPath = existsSync(opts.repo) ? qualityLogPath(repo) : undefined;
  const extras = {
    lastKnownPid: state?.lastKnownPid ?? state?.pid,
    lastHealthyAt: state?.lastHealthyAt,
    lastExitCode: state?.lastExitCode,
    lastExitSignal: state?.lastExitSignal,
    lastExitAt: state?.lastExitAt,
    logPath,
    port,
    runtimeMode: state?.runtimeMode,
  };
  const health = await fetchHealth(url);
  if (health && (rootsMatch(health.allowedRoot, repo) || (state?.pid && health.pid === state.pid))) {
    patchState(repo, { lastHealthyAt: new Date().toISOString(), lastKnownPid: health.pid ?? state?.pid });
    return {
      status: "healthy",
      pid: health.pid ?? state?.pid,
      url,
      db,
      reused: true,
      sqliteBackend: health.sqliteEngine ?? undefined,
      ...extras,
      lastHealthyAt: new Date().toISOString(),
    };
  }
  const workerLive = Boolean(workers.get(repo));
  if (state?.pid && !isAlive(state.pid)) {
    return {
      status: "stopped",
      pid: state.pid,
      url,
      db,
      reused: false,
      diagnostic: "last known Quality pid is not running; exit reason was not recorded by this process",
      ...extras,
    };
  }
  if (health && health.service === "quality-service" && !rootsMatch(health.allowedRoot, repo)) {
    return {
      status: "unavailable",
      url,
      db,
      reused: false,
      diagnostic: "Quality is healthy for a different repository",
      ...extras,
    };
  }
  if (state?.runtimeMode === "worker" && !workerLive && !health) {
    if (state.lastExitCode != null && state.lastExitCode !== 0) {
      return {
        status: "failed",
        pid: state.pid,
        url,
        db,
        reused: false,
        diagnostic: "Quality worker exited; see lastExitCode and logPath",
        ...extras,
      };
    }
    return {
      status: state.lastExitAt ? "stopped" : "unknown",
      pid: state.pid,
      url,
      db,
      reused: false,
      diagnostic: state.lastExitAt
        ? "Quality worker is no longer in this Runtime process"
        : "Quality worker is not answering /health; cause is not recorded",
      ...extras,
    };
  }
  if (!state && !health) {
    return { status: "not_started", url, db, reused: false, logPath, port };
  }
  return {
    status: "unavailable",
    pid: state?.pid,
    url,
    db,
    reused: false,
    diagnostic: health ? undefined : "Quality /health is not answering",
    ...extras,
  };
}

async function ensureQualityOnce(opts: { repo: string }): Promise<QualityEnsureResult> {
  const t0 = Date.now();
  qlog("quality.ensure.start");
  const repo = repoKey(opts.repo);
  const db = qualityDbPath(repo);
  const logPath = qualityLogPath(repo);
  const timeoutMs = startupTimeoutMs();

  const probe = await probeQuality({ repo });
  if (probe.status === "healthy") {
    qlog(`quality.ensure.done durationMs=${Date.now() - t0} reused=true`);
    return {
      ...probe,
      status: "healthy",
      reused: true,
      durationMs: Date.now() - t0,
    };
  }

  const executable = resolveQualityExecutable();
  qlog(`quality.entry.resolve ${executable ? "yes" : "no"}`);
  if (!executable) {
    fail(
      QUALITY_CODES.QUALITY_PACKAGE_MISSING,
      "Quality service executable is not packaged with Praxis Runtime",
      "quality.entry.resolve",
      t0,
      { healthUrl: probe.url, logPath },
    );
  }
  qlog(`quality.entry.resolve path=${executable}`);
  if (!existsSync(executable)) {
    fail(
      QUALITY_CODES.QUALITY_PACKAGE_MISSING,
      `Quality service executable missing: ${executable}`,
      "quality.entry.resolve",
      t0,
      { executable, healthUrl: probe.url, logPath },
    );
  }

  const runtime = resolveQualityChildRuntime();
  qlog(
    `quality.node.resolve parent=${runtime.parent.execPath} parentVersion=${runtime.parent.version} child=${runtime.execPath} childVersion=${runtime.child.version || "unknown"} electron=${runtime.parent.electron ?? "no"}`,
  );
  qlog(
    `quality.sqlite.preflight parentLoad=${runtime.parent.moduleLoad} childLoad=${runtime.child.moduleLoad} childErrorCode=${runtime.child.errorCode ?? "none"}`,
  );
  if (runtime.child.moduleLoad !== "success") {
    qlog(
      `quality.sqlite.preflight node:sqlite unavailable in child; Quality will use bundled sql.js code=${runtime.child.errorCode ?? "none"}`,
    );
  }

  const diagnosticDetails = {
    executable,
    qualityEntry: executable,
    logPath,
    nodeVersion: runtime.child.version || runtime.parent.version,
    nodeExecutable: runtime.execPath,
    parentNodeExecutable: runtime.parent.execPath,
    parentNodeVersion: runtime.parent.version,
    moduleLoad: runtime.child.moduleLoad,
    moduleLoadErrorCode: runtime.child.errorCode,
    sqlitePreflightStage: "quality.sqlite.preflight",
    runtimeMode: runtime.mode,
    spawned: false,
    qualityHealthStatus: probe.status,
  };

  const port = configuredPort();
  const url = urlForPort(port);
  if (await portListening(port)) {
    const occupant = await fetchHealth(url);
    if (occupant && rootsMatch(occupant.allowedRoot, repo)) {
      writeState(repo, {
        pid: occupant.pid,
        port,
        url,
        db,
        allowedRoot: repo,
        startedAt: new Date().toISOString(),
        runtimeMode: runtime.mode,
      });
      qlog(`quality.ensure.done durationMs=${Date.now() - t0} reused=true`);
      return {
        status: "healthy",
        pid: occupant.pid,
        url,
        db,
        reused: true,
        durationMs: Date.now() - t0,
        logPath,
        executable,
        cwd: repo,
        port,
        runtimeMode: runtime.mode,
        sqliteBackend: occupant.sqliteEngine ?? undefined,
      };
    }
    fail(
      QUALITY_CODES.QUALITY_PORT_UNAVAILABLE,
      `Quality port ${port} is already in use by another process`,
      "port",
      t0,
      { ...diagnosticDetails, healthUrl: url, port },
    );
  }

  mkdirSync(qualityDir(repo), { recursive: true });
  qlog(`cwd resolved path=${repo}`);
  qlog(`db path resolved path=${db}`);

  let pid: number | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let runtimeMode: QualityRuntimeMode = runtime.mode;

  if (runtime.mode === "worker") {
    qlog("quality.spawn skipped; starting Quality worker in the MCP runtime");
    const workerEnv: NodeJS.ProcessEnv = { ...process.env, ...runtime.extraEnv };
    delete workerEnv.PORT;
    workerEnv.PRAXIS_QUALITY_PORT = String(port);
    workerEnv.PRAXIS_QUALITY_DB = db;
    workerEnv.PRAXIS_QUALITY_ALLOWED_ROOT = repo;
    workerEnv.PRAXIS_QUALITY_HOST = "127.0.0.1";
    let worker!: Worker;
    try {
      worker = startQualityWorker({ repo, entry: executable, logPath, env: workerEnv });
    } catch (err) {
      const errno = err as NodeJS.ErrnoException;
      fail(
        classifySpawnFailure(errno),
        errno instanceof Error ? errno.message : String(err),
        "quality.spawn",
        t0,
        {
          ...diagnosticDetails,
          ...spawnErrorFields(errno),
          cwd: repo,
          healthUrl: url,
          spawned: false,
          runtimeMode: "worker",
        },
      );
    }
    const started = await waitForWorkerStart(worker, 1500);
    pid = started.pid ?? process.pid;
    qlog(
      `quality.child.start mode=worker spawned=${started.spawned} pid=${pid} exitCode=${started.exitCode ?? "none"} spawnError=${started.error?.code ?? "none"}`,
    );
    if (!started.spawned || started.error || started.exitCode !== undefined) {
      try {
        void worker.terminate();
      } catch {
        /* ignore */
      }
      workers.delete(repoKey(repo));
      fail(
        started.error ? classifySpawnFailure(started.error) : QUALITY_CODES.QUALITY_PROCESS_EXITED,
        started.error
          ? safeErrorMessage(started.error.message)
          : `Quality worker exited before becoming healthy (exit=${started.exitCode ?? "unknown"})`,
        "quality.spawn",
        t0,
        {
          ...diagnosticDetails,
          ...spawnErrorFields(started.error),
          cwd: repo,
          healthUrl: url,
          spawned: started.spawned,
          pid,
          exitCode: started.exitCode,
          runtimeMode: "worker",
        },
      );
    }
    worker.on("exit", (code) => {
      exitCode = code;
    });
  } else {
    const env: NodeJS.ProcessEnv = { ...process.env, ...runtime.extraEnv };
    delete env.PORT;
    env.PRAXIS_QUALITY_PORT = String(port);
    env.PRAXIS_QUALITY_DB = db;
    env.PRAXIS_QUALITY_ALLOWED_ROOT = repo;
    env.PRAXIS_QUALITY_HOST = "127.0.0.1";

    const logFd = openSync(logPath, "a");
    qlog("quality.spawn");
    let child: ChildProcess;
    try {
      child = spawn(runtime.execPath, [...runtime.extraArgs, executable], {
        cwd: repo,
        env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } catch (err) {
      closeSync(logFd);
      const errno = err as NodeJS.ErrnoException;
      fail(
        classifySpawnFailure(errno),
        errno instanceof Error ? errno.message : String(err),
        "quality.spawn",
        t0,
        {
          ...diagnosticDetails,
          ...spawnErrorFields(errno),
          cwd: repo,
          healthUrl: url,
          spawned: false,
        },
      );
    }

    const started = await waitForChildStart(child, 1500);
    closeSync(logFd);
    pid = started.pid;
    qlog(
      `quality.child.start spawned=${started.spawned} pid=${pid ?? "none"} exitCode=${started.exitCode ?? "none"} spawnError=${started.error?.code ?? "none"}`,
    );

    if (!started.spawned || started.error || started.exitCode !== undefined || started.exitSignal) {
      fail(
        started.error ? classifySpawnFailure(started.error) : QUALITY_CODES.QUALITY_PROCESS_EXITED,
        started.error
          ? safeErrorMessage(started.error.message)
          : `Quality service exited before becoming healthy (exit=${started.exitCode ?? started.exitSignal ?? "unknown"})`,
        "quality.spawn",
        t0,
        {
          ...diagnosticDetails,
          ...spawnErrorFields(started.error),
          cwd: repo,
          healthUrl: url,
          spawned: started.spawned,
          pid,
          exitCode: started.exitCode,
          exitSignal: started.exitSignal,
        },
      );
    }

    child.unref();
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on("error", (err) => {
      qlog(`process error ${safeErrorMessage(err)}`);
    });
  }

  if (!pid) {
    fail(
      QUALITY_CODES.QUALITY_SPAWN_FAILED,
      "Quality service spawn did not return a pid after waiting for spawn/error/exit",
      "quality.spawn",
      t0,
      { ...diagnosticDetails, cwd: repo, healthUrl: url, spawned: false },
    );
  }

  writeState(repo, {
    pid,
    port,
    url,
    db,
    allowedRoot: repo,
    startedAt: new Date().toISOString(),
    runtimeMode,
  });

  let attempt = 0;
  while (Date.now() - t0 < timeoutMs) {
    attempt += 1;
    qlog(`quality.health attempt=${attempt}`);
    if (exitCode !== null) {
      const logTail = safeLogTail(logPath);
      const wasmMissing = /wasm asset is missing|QUALITY_SQLITE_UNAVAILABLE/i.test(logTail);
      const sqliteLoad = /ERR_UNKNOWN_BUILTIN_MODULE|node:sqlite/i.test(logTail);
      const dbFailed = /sqlite|SQLITE|database|sql\.js|sqljs/i.test(logTail);
      if (runtimeMode === "process") killPid(pid);
      else stopQuality(repo);
      const code = wasmMissing
        ? QUALITY_CODES.QUALITY_SQLITE_UNAVAILABLE
        : sqliteLoad && dbFailed
          ? QUALITY_CODES.QUALITY_SQLITE_MODULE_LOAD_FAILED
          : dbFailed
            ? QUALITY_CODES.QUALITY_DB_INIT_FAILED
            : QUALITY_CODES.QUALITY_PROCESS_EXITED;
      fail(
        code,
        wasmMissing
          ? "Quality SQLite wasm backend is missing from the packaged Runtime"
          : sqliteLoad
            ? "Quality SQLite module failed to load in the child process"
            : dbFailed
              ? "Quality SQLite initialization failed"
              : `Quality service exited before becoming healthy (exit=${exitCode})`,
        wasmMissing || sqliteLoad || dbFailed ? "quality.db.init" : "quality.child.start",
        t0,
        {
          ...diagnosticDetails,
          cwd: repo,
          healthUrl: url,
          exitCode,
          exitSignal,
          pid,
          spawned: true,
          runtimeMode,
          stderrTail: logTail,
        },
      );
    }
    const health = await fetchHealth(url);
    if (health && (rootsMatch(health.allowedRoot, repo) || health.pid === pid)) {
      qlog("quality.health ready");
      qlog(`quality.ensure.done durationMs=${Date.now() - t0}`);
      writeState(repo, {
        pid,
        port,
        url,
        db,
        allowedRoot: repo,
        startedAt: readState(repo)?.startedAt ?? new Date().toISOString(),
        lastHealthyAt: new Date().toISOString(),
        lastKnownPid: pid,
        runtimeMode,
      });
      return {
        status: "started",
        pid,
        url,
        db,
        reused: false,
        durationMs: Date.now() - t0,
        logPath,
        executable,
        cwd: repo,
        port,
        runtimeMode,
        sqliteBackend: health.sqliteEngine ?? undefined,
      };
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  if (runtimeMode === "process") killPid(pid);
  else stopQuality(repo);
  fail(
    QUALITY_CODES.QUALITY_HEALTH_TIMEOUT,
    `Quality service did not become healthy within ${timeoutMs}ms`,
    "quality.health",
    t0,
    { ...diagnosticDetails, cwd: repo, healthUrl: url, pid, timeoutMs, spawned: true, runtimeMode },
  );
}

export async function ensureQuality(opts: { repo: string }): Promise<QualityEnsureResult> {
  const key = repoKey(opts.repo);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = ensureQualityOnce(opts).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

export function resetQualityEnsureForTests(repo?: string): void {
  if (repo) {
    const dir = qualityDir(repo);
    stopQuality(repo);
    rmSync(dir, { recursive: true, force: true });
    inFlight.delete(repoKey(repo));
    return;
  }
  inFlight.clear();
}
