import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
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
import { dirname, isAbsolute, join, resolve } from "node:path";
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
} as const;

export type QualityErrorCode = (typeof QUALITY_CODES)[keyof typeof QUALITY_CODES];

export type QualityProbeStatus =
  | "not_started"
  | "healthy"
  | "unavailable"
  | "failed";

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
};

type QualityStateFile = {
  pid?: number;
  port?: number;
  url?: string;
  db?: string;
  allowedRoot?: string;
  startedAt?: string;
};

type HealthBody = {
  ok?: boolean;
  service?: string;
  allowedRoot?: string | null;
  db?: string | null;
  pid?: number;
  port?: number;
};

const inFlight = new Map<string, Promise<QualityEnsureResult>>();

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
  const state = readState(repo);
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

function nodeSqliteAvailable(): boolean {
  const r = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
    encoding: "utf8",
  });
  return (r.status ?? 1) === 0;
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
  const health = await fetchHealth(url);
  if (health && (rootsMatch(health.allowedRoot, repo) || (state?.pid && health.pid === state.pid))) {
    return {
      status: "healthy",
      pid: health.pid ?? state?.pid,
      url,
      db,
      reused: true,
      logPath,
      port,
    };
  }
  if (state?.pid && !isAlive(state.pid)) {
    return {
      status: "failed",
      pid: state.pid,
      url,
      db,
      reused: false,
      logPath,
      port,
    };
  }
  if (health && health.service === "quality-service" && !rootsMatch(health.allowedRoot, repo)) {
    return {
      status: "unavailable",
      url,
      db,
      reused: false,
      logPath,
      port,
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
    logPath,
    port,
  };
}

async function ensureQualityOnce(opts: { repo: string }): Promise<QualityEnsureResult> {
  const t0 = Date.now();
  qlog("ensure start");
  const repo = repoKey(opts.repo);
  const db = qualityDbPath(repo);
  const logPath = qualityLogPath(repo);
  const timeoutMs = startupTimeoutMs();

  const probe = await probeQuality({ repo });
  if (probe.status === "healthy") {
    qlog(`ensure done durationMs=${Date.now() - t0} reused=true`);
    return {
      ...probe,
      status: "healthy",
      reused: true,
      durationMs: Date.now() - t0,
    };
  }

  const executable = resolveQualityExecutable();
  qlog(`package resolved ${executable ? "yes" : "no"}`);
  if (!executable) {
    fail(
      QUALITY_CODES.QUALITY_PACKAGE_MISSING,
      "Quality service executable is not packaged with Praxis Runtime",
      "resolve-executable",
      t0,
      { healthUrl: probe.url, logPath },
    );
  }
  qlog(`executable resolved path=${executable}`);
  if (!existsSync(executable)) {
    fail(
      QUALITY_CODES.QUALITY_PACKAGE_MISSING,
      `Quality service executable missing: ${executable}`,
      "resolve-executable",
      t0,
      { executable, healthUrl: probe.url, logPath },
    );
  }

  if (!nodeSqliteAvailable()) {
    fail(
      QUALITY_CODES.QUALITY_STARTUP_FAILED,
      "Quality service requires Node.js 22+ with node:sqlite",
      "node-sqlite",
      t0,
      { executable, node: process.version, logPath },
    );
  }

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
      });
      qlog(`ensure done durationMs=${Date.now() - t0} reused=true`);
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
      };
    }
    fail(
      QUALITY_CODES.QUALITY_PORT_UNAVAILABLE,
      `Quality port ${port} is already in use by another process`,
      "port",
      t0,
      { healthUrl: url, logPath, port, executable },
    );
  }

  mkdirSync(qualityDir(repo), { recursive: true });
  qlog(`cwd resolved path=${repo}`);
  qlog(`db path resolved path=${db}`);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PORT;
  env.PRAXIS_QUALITY_PORT = String(port);
  env.PRAXIS_QUALITY_DB = db;
  env.PRAXIS_QUALITY_ALLOWED_ROOT = repo;
  env.PRAXIS_QUALITY_HOST = "127.0.0.1";

  const logFd = openSync(logPath, "a");
  qlog("spawn requested");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [executable], {
      cwd: repo,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } catch (err) {
    closeSync(logFd);
    fail(
      QUALITY_CODES.QUALITY_STARTUP_FAILED,
      err instanceof Error ? err.message : String(err),
      "spawn",
      t0,
      { executable, cwd: repo, healthUrl: url, logPath },
    );
  }
  closeSync(logFd);
  child.unref();
  const pid = child.pid;
  qlog(`process started pid=${pid ?? "unknown"}`);
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.on("exit", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
  });
  child.on("error", (err) => {
    qlog(`process error ${err instanceof Error ? err.message : String(err)}`);
  });

  if (!pid) {
    fail(
      QUALITY_CODES.QUALITY_STARTUP_FAILED,
      "Quality service spawn did not return a pid",
      "spawn",
      t0,
      { executable, cwd: repo, healthUrl: url, logPath },
    );
  }

  writeState(repo, {
    pid,
    port,
    url,
    db,
    allowedRoot: repo,
    startedAt: new Date().toISOString(),
  });

  let attempt = 0;
  while (Date.now() - t0 < timeoutMs) {
    attempt += 1;
    qlog(`health attempt=${attempt}`);
    if (exitCode !== null) {
      const logTail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-2000) : "";
      const dbFailed = /sqlite|SQLITE|database/i.test(logTail);
      killPid(pid);
      fail(
        dbFailed ? QUALITY_CODES.QUALITY_DB_INIT_FAILED : QUALITY_CODES.QUALITY_PROCESS_EXITED,
        dbFailed
          ? "Quality SQLite initialization failed"
          : `Quality service exited before becoming healthy (exit=${exitCode})`,
        dbFailed ? "db-init" : "process-exit",
        t0,
        {
          executable,
          cwd: repo,
          healthUrl: url,
          logPath,
          exitCode,
          exitSignal,
          pid,
        },
      );
    }
    const health = await fetchHealth(url);
    if (health && (rootsMatch(health.allowedRoot, repo) || health.pid === pid)) {
      qlog("health ready");
      qlog(`ensure done durationMs=${Date.now() - t0}`);
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
      };
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  killPid(pid);
  fail(
    QUALITY_CODES.QUALITY_HEALTH_TIMEOUT,
    `Quality service did not become healthy within ${timeoutMs}ms`,
    "health",
    t0,
    { executable, cwd: repo, healthUrl: url, logPath, pid, timeoutMs },
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
