import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type QualityEnsureResult = {
  status: "healthy" | "started" | "unavailable";
  pid?: number;
  url: string;
  db?: string;
  reused: boolean;
};

function defaultUrl(): string {
  return process.env.PRAXIS_QUALITY_URL || "http://127.0.0.1:8792/health";
}

async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

function resolveQualityService(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    return req.resolve("@praxis/quality-service/package.json");
  } catch {
    return undefined;
  }
}

export async function ensureQuality(opts: {
  repo: string;
}): Promise<QualityEnsureResult> {
  const url = defaultUrl();
  const db =
    process.env.PRAXIS_QUALITY_DB ??
    join(opts.repo, ".praxis-quality", "quality.sqlite");
  const pidFile = join(opts.repo, ".praxis-quality", "quality.pid");
  if (await healthy(url)) {
    let pid: number | undefined;
    if (existsSync(pidFile)) {
      pid = Number(readFileSync(pidFile, "utf8").trim()) || undefined;
    }
    return { status: "healthy", pid, url, db, reused: true };
  }
  const pkg = resolveQualityService();
  if (!pkg) {
    return { status: "unavailable", url, db, reused: false };
  }
  mkdirSync(dirname(db), { recursive: true });
  const serviceRoot = dirname(pkg);
  const entry = join(serviceRoot, "dist", "main.js");
  if (!existsSync(entry)) {
    const built = spawnSync("npm run build", {
      cwd: serviceRoot,
      shell: true,
      encoding: "utf8",
    });
    if ((built.status ?? 1) !== 0 || !existsSync(entry)) {
      return { status: "unavailable", url, db, reused: false };
    }
  }
  const child = spawn(process.execPath, [entry], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      PORT: process.env.PORT ?? "8792",
      PRAXIS_QUALITY_DB: db,
      PRAXIS_QUALITY_ALLOWED_ROOT: opts.repo,
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  if (pid) writeFileSync(pidFile, `${pid}\n`);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (await healthy(url)) {
      return { status: "started", pid, url, db, reused: false };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { status: "unavailable", pid, url, db, reused: false };
}
