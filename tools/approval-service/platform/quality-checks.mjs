/** Executable Quality checks for the platform adapters and installers. Declared honestly: what ran, and what could not. */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ADAPTERS } from "./index.mjs";


import { existsSync as __exists } from "node:fs";
/** The Desktop runtime's own process.execPath is not a Node that can be spawned; find a real one. */
function nodeBinary() {
  for (const candidate of [process.env.PRAXIS_NODE, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) if (candidate && __exists(candidate)) return candidate;
  return "node";
}


import { mkdirSync as __mk, readFileSync as __rf, statSync as __st, writeFileSync as __wf } from "node:fs";
import { tmpdir as __tmp } from "node:os";
import { join as __join } from "node:path";
/**
 * Slow scenarios (a Linux container, the packaged extension) run once and their result is reused for a few minutes: the
 * preview and the apply of one verification, and a retry after a client timeout, must not each repeat a multi-minute run.
 * The scenario really executed within the window; only the repetition is skipped.
 */
function cachedRun(name, ttlMs, fn) {
  const dir = __join(__tmp(), "praxis-quality-cache");
  __mk(dir, { recursive: true });
  const file = __join(dir, `${name}.json`);
  try {
    if (Date.now() - __st(file).mtimeMs < ttlMs) return JSON.parse(__rf(file, "utf8"));
  } catch {
    /* no fresh result */
  }
  const value = fn();
  __wf(file, JSON.stringify(value));
  return value;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Runs the Linux container acceptance (a real Linux kernel with separate uids). BLOCKED-by-environment when Docker or the image is absent. */
export function linuxContainerLifecycle() {
  return cachedRun("linux-container", 15 * 60_000, runLinuxContainer);
}

function runLinuxContainer() {
  const r = spawnSync(nodeBinary(), [join(here, "../acceptance/linux-container.mjs")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000, env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` } });
  const last = r.stdout.trim().split("\n").filter((l) => l.startsWith("LINUX-CONTAINER") || l.startsWith("BLOCKED")).pop() ?? "no result";
  const failed = r.stdout.split("\n").filter((l) => l.startsWith("FAIL")).length;
  return { summary: last.replace(/: \d+\/\d+ checks/, ""), failedChecks: failed, exit: r.status };
}

export function platformStatusesAreHonest() {
  const status = Object.fromEntries(Object.entries(ADAPTERS).map(([os, adapter]) => [os, adapter.status.tested.split(/[:.]/)[0].replace(/\s+/g, " ").trim()]));
  return status;
}

export function macosPackageBuiltAndInspected() {
  if (process.platform !== "darwin") return { skipped: "not macOS" };
  const out = JSON.parse(execFileSync(nodeBinary(), [join(here, "../packaging/build.mjs"), "--variant", "production", "--macos-pkg"], { encoding: "utf8" }));
  const files = execFileSync("pkgutil", ["--payload-files", out.pkg], { encoding: "utf8" }).split("\n").filter((f) => f && !f.includes("._"));
  const signature = spawnSync("pkgutil", ["--check-signature", out.pkg], { encoding: "utf8" }).stdout;
  return { daemonPlist: files.some((f) => f.endsWith("co.praxis.approval-service.plist") && f.includes("LaunchDaemons")), agentPlist: files.some((f) => /LaunchAgents/.test(f)), ctl: files.some((f) => f.endsWith("/code/ctl.sh")), signed: !/no signature/i.test(signature) };
}
