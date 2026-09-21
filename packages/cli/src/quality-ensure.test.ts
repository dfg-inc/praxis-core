import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ensureQuality,
  probeQuality,
  QUALITY_CODES,
  QualityStartupError,
  resetQualityEnsureForTests,
  stopQuality,
} from "./quality-ensure.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

beforeAll(() => {
  const entry = join(root, "apps/quality-service/dist/main.js");
  if (!existsSync(entry)) {
    const built = spawnSync("npm run build -w @praxis/contracts -w @praxis/knowledge -w @praxis/quality-service", {
      cwd: root,
      shell: true,
      encoding: "utf8",
    });
    if ((built.status ?? 1) !== 0) {
      throw new Error(`quality-service build failed\n${built.stderr || built.stdout}`);
    }
  }
});

function tmpRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "praxis-q-ensure-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function occupyPort(port: number): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.destroy();
    });
    server.listen(port, "127.0.0.1", () => {
      resolve(
        () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      );
    });
    server.on("error", reject);
  });
}

const previous = {
  entry: process.env.PRAXIS_QUALITY_ENTRY,
  port: process.env.PRAXIS_QUALITY_PORT,
  url: process.env.PRAXIS_QUALITY_URL,
  timeout: process.env.PRAXIS_QUALITY_STARTUP_TIMEOUT_MS,
  sqlite: process.env.PRAXIS_QUALITY_SQLITE,
  simulated: process.env.PRAXIS_QUALITY_SIMULATED_EXEC_PATH,
  qualityNode: process.env.PRAXIS_QUALITY_NODE,
  db: process.env.PRAXIS_QUALITY_DB,
};

function restoreEnv() {
  for (const [key, val] of Object.entries({
    PRAXIS_QUALITY_ENTRY: previous.entry,
    PRAXIS_QUALITY_PORT: previous.port,
    PRAXIS_QUALITY_URL: previous.url,
    PRAXIS_QUALITY_STARTUP_TIMEOUT_MS: previous.timeout,
    PRAXIS_QUALITY_SQLITE: previous.sqlite,
    PRAXIS_QUALITY_SIMULATED_EXEC_PATH: previous.simulated,
    PRAXIS_QUALITY_NODE: previous.qualityNode,
    PRAXIS_QUALITY_DB: previous.db,
  })) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

const repos: string[] = [];

afterEach(() => {
  while (repos.length) {
    const repo = repos.pop()!;
    resetQualityEnsureForTests(repo);
  }
  restoreEnv();
});

describe("quality ensure", { timeout: 20_000 }, () => {
  it("status is not_started before ensure and does not create sqlite", async () => {
    const repo = tmpRepo();
    repos.push(repo);
    process.env.PRAXIS_QUALITY_PORT = String(await freePort());
    const status = await probeQuality({ repo });
    expect(status.status).toBe("not_started");
    expect(existsSync(join(repo, ".praxis-quality", "quality.sqlite"))).toBe(false);
  });

  it("starts Quality, initializes sqlite, and reuses the same process", async () => {
    const repo = tmpRepo();
    repos.push(repo);
    const port = await freePort();
    process.env.PRAXIS_QUALITY_PORT = String(port);
    delete process.env.PRAXIS_QUALITY_ENTRY;
    const first = await ensureQuality({ repo });
    expect(["started", "healthy"]).toContain(first.status);
    expect(first.reused).toBe(false);
    expect(first.pid).toBeTruthy();
    expect(existsSync(join(repo, ".praxis-quality", "quality.sqlite"))).toBe(true);
    const health = await fetch(first.url);
    expect(health.ok).toBe(true);
    const body = (await health.json()) as { allowedRoot?: string; service?: string };
    expect(body.service).toBe("quality-service");
    expect(body.allowedRoot).toBe(realpathSync(repo));
    const second = await ensureQuality({ repo });
    expect(second.reused).toBe(true);
    expect(second.pid).toBe(first.pid);
    const after = await probeQuality({ repo });
    expect(after.status).toBe("healthy");
  });

  it("returns QUALITY_PACKAGE_MISSING for a missing executable", async () => {
    const repo = tmpRepo();
    repos.push(repo);
    process.env.PRAXIS_QUALITY_PORT = String(await freePort());
    process.env.PRAXIS_QUALITY_ENTRY = join(repo, "no-such-quality.cjs");
    try {
      await ensureQuality({ repo });
      throw new Error("expected missing executable to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(QualityStartupError);
      expect((err as QualityStartupError).code).toBe(QUALITY_CODES.QUALITY_PACKAGE_MISSING);
    }
  });

  it("returns QUALITY_PROCESS_EXITED when the child crashes", async () => {
    const repo = tmpRepo();
    repos.push(repo);
    process.env.PRAXIS_QUALITY_PORT = String(await freePort());
    const crash = join(repo, "crash.cjs");
    writeFileSync(crash, "process.exit(1);\n");
    process.env.PRAXIS_QUALITY_ENTRY = crash;
    try {
      await ensureQuality({ repo });
      throw new Error("expected crash to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(QualityStartupError);
      expect((err as QualityStartupError).code).toBe(QUALITY_CODES.QUALITY_PROCESS_EXITED);
      expect((err as QualityStartupError).details.exitCode).toBe(1);
    }
  });

  it("returns QUALITY_PORT_UNAVAILABLE when the port is occupied", async () => {
    const repo = tmpRepo();
    repos.push(repo);
    const port = await freePort();
    process.env.PRAXIS_QUALITY_PORT = String(port);
    const release = await occupyPort(port);
    try {
      await ensureQuality({ repo });
      throw new Error("expected port conflict to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(QualityStartupError);
      expect((err as QualityStartupError).code).toBe(QUALITY_CODES.QUALITY_PORT_UNAVAILABLE);
    } finally {
      await release();
    }
  });

  it("bounds health timeout", async () => {
    const repo = tmpRepo();
    repos.push(repo);
    process.env.PRAXIS_QUALITY_PORT = String(await freePort());
    process.env.PRAXIS_QUALITY_STARTUP_TIMEOUT_MS = "600";
    const hang = join(repo, "hang.cjs");
    writeFileSync(hang, "setInterval(() => {}, 10000);\n");
    process.env.PRAXIS_QUALITY_ENTRY = hang;
    const t0 = Date.now();
    try {
      await ensureQuality({ repo });
      throw new Error("expected timeout");
    } catch (err) {
      expect(err).toBeInstanceOf(QualityStartupError);
      expect((err as QualityStartupError).code).toBe(QUALITY_CODES.QUALITY_HEALTH_TIMEOUT);
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      stopQuality(repo);
    }
  });

  it("probes node:sqlite in-process without mapping every failure to Node 22+", async () => {
    const { probeSqliteInProcess, classifySqliteProbeError } = await import("./quality-ensure.js");
    const probe = probeSqliteInProcess();
    expect(probe.execPath).toBe(process.execPath);
    expect(probe.version).toBe(process.version);
    expect(["success", "failure"]).toContain(probe.moduleLoad);
    if (probe.moduleLoad === "failure") {
      expect(classifySqliteProbeError(probe)).not.toBe(QUALITY_CODES.QUALITY_STARTUP_FAILED);
    }
  });

  it("classifies builtin sqlite load failures without a Node 22 message", async () => {
    const { classifySqliteProbeError } = await import("./quality-ensure.js");
    const code = classifySqliteProbeError({
      execPath: "/fake/node",
      version: "v24.20.0",
      versionsNode: "24.20.0",
      platform: process.platform,
      arch: process.arch,
      moduleLoad: "failure",
      errorCode: "ERR_UNKNOWN_BUILTIN_MODULE",
      errorMessage: "No such built-in module: node:sqlite",
    });
    expect(code).toBe(QUALITY_CODES.QUALITY_SQLITE_UNAVAILABLE);
  });

  it("starts Quality with bundled sql.js when node:sqlite is forced off", async () => {
    const repo = tmpRepo();
    repos.push(repo);
    const port = await freePort();
    process.env.PRAXIS_QUALITY_PORT = String(port);
    process.env.PRAXIS_QUALITY_SQLITE = "sqljs";
    delete process.env.PRAXIS_QUALITY_ENTRY;
    const first = await ensureQuality({ repo });
    expect(["started", "healthy"]).toContain(first.status);
    const health = await fetch(first.url);
    expect(health.ok).toBe(true);
    const body = (await health.json()) as { sqliteEngine?: string };
    expect(body.sqliteEngine).toBe("sqljs");
    expect(first.sqliteBackend).toBe("sqljs");
    expect(existsSync(join(repo, ".praxis-quality", "quality.sqlite"))).toBe(true);
  });

  it("selects a worker runtime for Claude Helper (Plugin) execPath", async () => {
    const { isElectronHelperExecutable, resolveQualityChildRuntime } = await import("./quality-ensure.js");
    const helper =
      "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Plugin).app/Contents/MacOS/Claude Helper (Plugin)";
    expect(isElectronHelperExecutable(helper)).toBe(true);
    expect(isElectronHelperExecutable(process.execPath)).toBe(false);
    process.env.PRAXIS_QUALITY_SIMULATED_EXEC_PATH = helper;
    const runtime = resolveQualityChildRuntime();
    expect(runtime.mode).toBe("worker");
    expect(runtime.execPath).toBe(process.execPath);
    expect(runtime.parent.execPath).toBe(helper);
  });

  it("starts Quality as a worker when the parent executable is an Electron helper", async () => {
    const repo = tmpRepo();
    repos.push(repo);
    const port = await freePort();
    process.env.PRAXIS_QUALITY_PORT = String(port);
    process.env.PRAXIS_QUALITY_SIMULATED_EXEC_PATH =
      "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Plugin).app/Contents/MacOS/Claude Helper (Plugin)";
    delete process.env.PRAXIS_QUALITY_ENTRY;
    const first = await ensureQuality({ repo });
    expect(["started", "healthy"]).toContain(first.status);
    expect(first.runtimeMode).toBe("worker");
    expect(first.pid).toBe(process.pid);
    const health = await fetch(first.url);
    expect(health.ok).toBe(true);
    expect(existsSync(join(repo, ".praxis-quality", "quality.sqlite"))).toBe(true);
    const second = await ensureQuality({ repo });
    expect(second.reused).toBe(true);
    expect(second.pid).toBe(first.pid);
  });

  it("captures async spawn errors instead of missing pid", async () => {
    const repo = tmpRepo();
    repos.push(repo);
    process.env.PRAXIS_QUALITY_PORT = String(await freePort());
    process.env.PRAXIS_QUALITY_NODE = join(repo, "missing-node-binary");
    try {
      await ensureQuality({ repo });
      throw new Error("expected missing node executable to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(QualityStartupError);
      const qerr = err as QualityStartupError;
      expect(qerr.code).toBe(QUALITY_CODES.QUALITY_EXECUTABLE_NOT_FOUND);
      expect(qerr.details.spawnErrorCode).toBe("ENOENT");
      expect(String(qerr.message)).not.toMatch(/did not return a pid/i);
    }
  });
});
