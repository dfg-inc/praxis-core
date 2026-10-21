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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const versionForArtifacts = process.env.PRAXIS_BUILD_VERSION_OVERRIDE || SERVICE_VERSION; // test builds of an "upgrade" artifact only; the repository version is untouched
const out = resolve(root, "dist/approval-service", process.env.PRAXIS_BUILD_VERSION_OVERRIDE ? `${variant}-${versionForArtifacts}` : variant);
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
for (const [rel, src] of [["macos/preinstall", "macos-preinstall.sh"], ["macos/postinstall", "macos-postinstall.sh"], ["macos/ctl.sh", "macos-ctl.sh"]]) write(rel, readFileSync(join(here, src), "utf8"), 0o755);
for (const path of ["macos/preinstall", "macos/postinstall", "macos/ctl.sh", "linux/install.sh"].filter((p) => existsSync(join(out, p)))) execFileSync("sh", ["-n", join(out, path)]);
execFileSync("sh", ["-n", join(here, "linux/install.sh")]);
if (process.platform === "darwin") execFileSync("plutil", ["-lint", join(out, "macos/co.praxis.approval-service.plist")], { stdio: "pipe" });

const manifest = {
  name: "praxis-approval-service",
  version: versionForArtifacts,
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
  const baseDir = "Library/Application Support/Praxis/ApprovalService";
  const code = join(stage, baseDir, "code");
  mkdirSync(join(code, "node/bin"), { recursive: true });
  copyFileSync(join(payload, "praxis-approval-service.mjs"), join(code, "praxis-approval-service.mjs"));
  // The daemon must not execute code from locations the agent can write, so it ships its own root-owned Node. A Node
  // that links libraries from elsewhere (Homebrew, nvm) is not self-contained and is refused.
  const nodeSource = flag("--node");
  const pkgArch = flag("--macos-arch") ?? (process.arch === "arm64" ? "arm64" : "x64");
  manifest.macosArch = pkgArch;
  manifest.nodeRuntime = { bundled: false, reason: "no --node <self-contained official Node binary> was supplied; the package payload is complete except the runtime, so the daemon cannot start until one is installed at \"/Library/Application Support/Praxis/ApprovalService/code/node/bin/node\"" };
  if (nodeSource) {
    const deps = execFileSync("otool", ["-L", nodeSource], { encoding: "utf8" }).split("\n").slice(1).map((l) => l.trim().split(" ")[0]).filter(Boolean);
    const foreign = deps.filter((d) => !d.startsWith("/usr/lib/") && !d.startsWith("/System/Library/"));
    if (foreign.length) throw new Error(`--node is not self-contained (it loads ${foreign.slice(0, 3).join(", ")}); use the official nodejs.org binary`);
    copyFileSync(nodeSource, join(code, "node/bin/node"));
    chmodSync(join(code, "node/bin/node"), 0o755);
    manifest.nodeRuntime = { bundled: true, sha256: sha(nodeSource), version: execFileSync(nodeSource, ["--version"], { encoding: "utf8" }).trim() };
  }
  copyFileSync(join(here, "macos-ctl.sh"), join(code, "ctl.sh"));
  chmodSync(join(code, "ctl.sh"), 0o755);
  writeFileSync(join(code, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(join(stage, "Library/LaunchDaemons"), { recursive: true });
  copyFileSync(join(out, "macos/co.praxis.approval-service.plist"), join(stage, "Library/LaunchDaemons/co.praxis.approval-service.plist"));
  const scripts = join(out, "pkg-scripts");
  mkdirSync(scripts, { recursive: true });
  const fill = (text) => text.replaceAll("@ARCH@", pkgArch).replaceAll("@VERSION@", versionForArtifacts);
  writeFileSync(join(scripts, "preinstall"), fill(readFileSync(join(here, "macos-preinstall.sh"), "utf8")), { mode: 0o755 });
  writeFileSync(join(scripts, "postinstall"), fill(readFileSync(join(here, "macos-postinstall.sh"), "utf8")), { mode: 0o755 });
  for (const s of ["preinstall", "postinstall"]) execFileSync("sh", ["-n", join(scripts, s)]);
  const pkg = join(out, `praxis-approval-service-${versionForArtifacts}-macos-${pkgArch}.pkg`);
  execFileSync("xattr", ["-cr", stage, scripts]);
  execFileSync("pkgbuild", ["--root", stage, "--scripts", scripts, "--identifier", "co.praxis.approval-service", "--version", versionForArtifacts.replace(/-.*/, ""), "--ownership", "recommended", "--install-location", "/", pkg], { stdio: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const listing = execFileSync("pkgutil", ["--payload-files", pkg], { encoding: "utf8" });
  manifest.components[pkg.slice(out.length + 1)] = {
    sha256: sha(pkg),
    bytes: statSync(pkg).size,
    arch: pkgArch,
    signed: false,
    note: "Unsigned: macOS Gatekeeper will ask the owner to approve it; distribution needs a Developer ID Installer certificate and notarization (not available here). The Node runtime is architecture specific: build once per architecture with that architecture's official Node binary (arm64 and x64).",
    payload: listing.split("\n").filter(Boolean).length,
  };
  manifest.macosPkg = pkg;
}

if (args.includes("--linux-tar")) {
  const nodeBin = flag("--linux-node");
  const arch = flag("--linux-arch");
  if (!nodeBin || !arch || !["x64", "arm64"].includes(arch)) throw new Error("--linux-tar needs --linux-node <official Linux node binary> and --linux-arch x64|arm64");
  const nodeVersion = flag("--linux-node-version");
  if (!/^v\d+\.\d+\.\d+$/.test(nodeVersion ?? "")) throw new Error("--linux-node-version vX.Y.Z is required (the version the supplied binary reports)");
  const name = `praxis-approval-service-${versionForArtifacts}-linux-${arch}`;
  const stage = join(out, name);
  mkdirSync(join(stage, "payload/node/bin"), { recursive: true });
  copyFileSync(join(payload, "praxis-approval-service.mjs"), join(stage, "payload/praxis-approval-service.mjs"));
  copyFileSync(nodeBin, join(stage, "payload/node/bin/node"));
  chmodSync(join(stage, "payload/node/bin/node"), 0o755);
  copyFileSync(join(here, "linux/install.sh"), join(stage, "install.sh"));
  chmodSync(join(stage, "install.sh"), 0o755);
  copyFileSync(join(out, "linux/praxis-approval.service"), join(stage, "praxis-approval.service"));
  manifest.linuxArch = arch;
  manifest.nodeRuntimeLinux = { bundled: true, version: nodeVersion, sha256: sha(nodeBin), source: "the official Node.js image binary supplied with --linux-node; verify it against nodejs.org checksums before distribution" };
  const stageManifest = { ...manifest, components: { ...manifest.components } };
  writeFileSync(join(stage, "MANIFEST.json"), `${JSON.stringify(stageManifest, null, 2)}\n`);
  const files = ["install.sh", "praxis-approval.service", "MANIFEST.json", "payload/praxis-approval-service.mjs", "payload/node/bin/node"];
  writeFileSync(join(stage, "SHA256SUMS"), files.map((f) => `${sha(join(stage, f))}  ${f}`).join("\n") + "\n");
  const tar = join(out, `${name}.tar.gz`);
  execFileSync("tar", ["-C", out, "-czf", tar, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  manifest.components[`${name}.tar.gz`] = { sha256: sha(tar), bytes: statSync(tar).size, arch, signed: false, note: "Unsigned archive; publish its SHA256 out of band." };
  manifest.linuxTar = tar;
}

if (args.includes("--windows-zip")) {
  const nodeExe = flag("--windows-node");
  const arch = flag("--windows-arch");
  const nodeVersion = flag("--windows-node-version");
  if (!nodeExe || !["x64", "arm64"].includes(arch ?? "") || !/^v\d+\.\d+\.\d+$/.test(nodeVersion ?? "")) throw new Error("--windows-zip needs --windows-node <official node.exe>, --windows-arch x64|arm64 and --windows-node-version vX.Y.Z");
  const name = `praxis-approval-service-${versionForArtifacts}-windows-${arch}`;
  const stage = join(out, name);
  mkdirSync(join(stage, "payload/node"), { recursive: true });
  copyFileSync(join(payload, "praxis-approval-service.mjs"), join(stage, "payload/praxis-approval-service.mjs"));
  copyFileSync(nodeExe, join(stage, "payload/node/node.exe"));
  copyFileSync(join(here, "windows/install.ps1"), join(stage, "install.ps1"));
  copyFileSync(join(here, "windows/ServiceHost.cs"), join(stage, "ServiceHost.cs"));
  manifest.windowsArch = arch;
  manifest.nodeRuntimeWindows = { bundled: true, version: nodeVersion, sha256: sha(nodeExe), source: "supplied with --windows-node; must be the official nodejs.org binary, checked against nodejs.org checksums before distribution" };
  writeFileSync(join(stage, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const files = ["install.ps1", "ServiceHost.cs", "MANIFEST.json", "payload/praxis-approval-service.mjs", "payload/node/node.exe"];
  writeFileSync(join(stage, "SHA256SUMS"), files.map((f) => `${sha(join(stage, f))}  ${f.replaceAll("/", "\\")}`).join("\n") + "\n");
  const zip = join(out, `${name}.zip`);
  execFileSync("zip", ["-qr", zip, name], { cwd: out });
  manifest.components[`${name}.zip`] = { sha256: sha(zip), bytes: statSync(zip).size, arch, signed: false, note: "UNTESTED on Windows. Unsigned: service host and installer are not Authenticode signed." };
  manifest.windowsZip = zip;
}

writeFileSync(join(out, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, out, variant, version: SERVICE_VERSION, pkg: manifest.macosPkg ?? null, linuxTar: manifest.linuxTar ?? null, windowsZip: manifest.windowsZip ?? null }, null, 2));
