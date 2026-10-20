#!/usr/bin/env node
/**
 * Builds the Approval Service artifacts into dist/approval-service/ WITHOUT privileges and without installing anything.
 *
 *   node tools/approval-service/packaging/build.mjs [--variant production|test] [--macos-pkg] [--node <self-contained node binary>]
 *
 * production: PRAXIS_BUNDLE_KIND is folded to "production" at build time, so development mode cannot be switched on.
 * test:       the same code without that constant, for the acceptance harness only. Never installed.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { ADAPTERS } from "../platform/index.mjs";
import { SERVICE_VERSION } from "../lib/version.mjs";
import { APPROVAL_SERVICE_PROTOCOL } from "../../../packages/contracts/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const variant = flag("--variant", "production");
if (variant !== "production" && variant !== "test") throw new Error("--variant must be production or test");
const out = resolve(root, "dist/approval-service", variant);
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

rmSync(out, { recursive: true, force: true });
const payload = join(out, "payload");
mkdirSync(payload, { recursive: true });

await build({
  entryPoints: [resolve(here, "../praxis-approval-service.mjs")],
  outfile: join(payload, "praxis-approval-service.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: {
    __PRAXIS_VERSION__: JSON.stringify(SERVICE_VERSION),
    ...(variant === "production" ? { "process.env.PRAXIS_BUNDLE_KIND": JSON.stringify("production") } : {}),
  },
  logLevel: "warning",
});

// platform artifacts (generated text; never executed here)
const artifacts = {};
const write = (rel, text, mode = 0o644) => {
  const path = join(out, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
  artifacts[rel] = { sha256: sha(path) };
};
write("macos/co.praxis.approval-service.plist", ADAPTERS.darwin.renderUnit());
write("linux/praxis-approval.service", ADAPTERS.linux.renderUnit());
write("windows/install-service.ps1", ADAPTERS.win32.renderUnit());
for (const os of ["darwin", "linux", "win32"]) {
  const adapter = ADAPTERS[os];
  write(`${adapter.defaults().id}/INSTALL-PLAN.json`, `${JSON.stringify({ platform: adapter.defaults().id, status: adapter.status, install: adapter.installPlan(), uninstall: adapter.uninstallPlan() }, null, 2)}\n`);
}
write("macos/postinstall", readFileSync(join(here, "macos-postinstall.sh"), "utf8"), 0o755);
write("macos/uninstall.sh", readFileSync(join(here, "macos-uninstall.sh"), "utf8"), 0o755);

for (const path of ["macos/postinstall", "macos/uninstall.sh"]) execFileSync("sh", ["-n", join(out, path)]);
if (process.platform === "darwin") execFileSync("plutil", ["-lint", join(out, "macos/co.praxis.approval-service.plist")], { stdio: "pipe" });

const manifest = {
  name: "praxis-approval-service",
  version: SERVICE_VERSION,
  protocol: APPROVAL_SERVICE_PROTOCOL,
  variant,
  bundleKind: variant === "production" ? "production" : "test (never installed)",
  builtAt: new Date().toISOString(),
  builtOn: `${process.platform}-${process.arch}`,
  node: process.version,
  components: {
    "payload/praxis-approval-service.mjs": { sha256: sha(join(payload, "praxis-approval-service.mjs")), role: "service, executor, operator page, CLI (one bundle)" },
    ...artifacts,
  },
  platforms: Object.fromEntries(Object.entries(ADAPTERS).map(([os, adapter]) => [os, adapter.status])),
};

if (args.includes("--macos-pkg")) {
  if (process.platform !== "darwin") throw new Error("--macos-pkg needs macOS (pkgbuild)");
  const stage = join(out, "pkg-root");
  const code = join(stage, "usr/local/libexec/praxis-approval-service");
  mkdirSync(join(code, "node/bin"), { recursive: true });
  copyFileSync(join(payload, "praxis-approval-service.mjs"), join(code, "praxis-approval-service.mjs"));
  // The daemon must not execute code from locations the agent can write, so it ships its own root-owned Node. A Node
  // that links libraries from elsewhere (Homebrew, nvm) is not self-contained and is refused.
  const nodeSource = flag("--node");
  manifest.nodeRuntime = { bundled: false, reason: "no --node <self-contained official Node binary> was supplied; the package payload is complete except the runtime, so the daemon cannot start until one is installed at /usr/local/libexec/praxis-approval-service/node/bin/node" };
  if (nodeSource) {
    const deps = execFileSync("otool", ["-L", nodeSource], { encoding: "utf8" }).split("\n").slice(1).map((l) => l.trim().split(" ")[0]).filter(Boolean);
    const foreign = deps.filter((d) => !d.startsWith("/usr/lib/") && !d.startsWith("/System/Library/"));
    if (foreign.length) throw new Error(`--node is not self-contained (it loads ${foreign.slice(0, 3).join(", ")}); use the official nodejs.org binary`);
    copyFileSync(nodeSource, join(code, "node/bin/node"));
    chmodSync(join(code, "node/bin/node"), 0o755);
    manifest.nodeRuntime = { bundled: true, sha256: sha(nodeSource), version: execFileSync(nodeSource, ["--version"], { encoding: "utf8" }).trim() };
  }
  copyFileSync(join(out, "macos/uninstall.sh"), join(code, "uninstall.sh"));
  chmodSync(join(code, "uninstall.sh"), 0o755);
  mkdirSync(join(stage, "Library/LaunchDaemons"), { recursive: true });
  copyFileSync(join(out, "macos/co.praxis.approval-service.plist"), join(stage, "Library/LaunchDaemons/co.praxis.approval-service.plist"));
  const scripts = join(out, "pkg-scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(join(out, "macos/postinstall"), join(scripts, "postinstall"));
  chmodSync(join(scripts, "postinstall"), 0o755);
  const pkg = join(out, `praxis-approval-service-${SERVICE_VERSION}-macos-${process.arch}.pkg`);
  execFileSync("xattr", ["-cr", stage, scripts]);
  execFileSync("pkgbuild", ["--root", stage, "--scripts", scripts, "--identifier", "co.praxis.approval-service", "--version", SERVICE_VERSION.replace(/-.*/, ""), "--ownership", "recommended", "--install-location", "/", pkg], { stdio: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const listing = execFileSync("pkgutil", ["--payload-files", pkg], { encoding: "utf8" });
  manifest.components[pkg.slice(out.length + 1)] = {
    sha256: sha(pkg),
    bytes: statSync(pkg).size,
    arch: process.arch,
    signed: false,
    note: "Unsigned: macOS Gatekeeper will ask the owner to approve it; distribution needs a Developer ID Installer certificate and notarization (not available here). The Node runtime is architecture specific: build once per architecture with that architecture's official Node binary (arm64 and x64).",
    payload: listing.split("\n").filter(Boolean).length,
  };
  manifest.macosPkg = pkg;
}

writeFileSync(join(out, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, out, variant, version: SERVICE_VERSION, pkg: manifest.macosPkg ?? null }, null, 2));
