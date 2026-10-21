/**
 * Tests of the BUILT artifacts, run unprivileged: the production bundle must fail closed on a host that is not
 * isolated and must not offer development mode; the macOS package must contain exactly the expected, root-owned
 * payload. Nothing here installs anything.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const buildScript = join(root, "tools/approval-service/packaging/build.mjs");
// Tests build into their own directory: they must never overwrite the real release package in dist/approval-service/production.
const TEST_OUT = mkdtempSync("/tmp/pas-artifact-");
const dist = (variant, ...rest) => join(TEST_OUT, ...rest);
const build = (...args) => JSON.parse(execFileSync(process.execPath, [buildScript, ...args], { encoding: "utf8", env: { ...process.env, PRAXIS_BUILD_OUT: TEST_OUT } }));

function config(mode) {
  const dir = mkdtempSync("/tmp/pas-");
  mkdirSync(join(dir, "state"), { mode: 0o700 });
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ mode, paths: { stateDir: join(dir, "state"), endpoint: join(dir, "s.sock"), codeDir: dir, configFile: file }, repositories: [], operator: { port: 0 } }));
  return file;
}
const runBundle = (variant, file) => spawnSync(process.execPath, [dist(variant, "payload/praxis-approval-service.mjs"), "run", "--config", file], { encoding: "utf8", timeout: 10_000 });

describe("built service bundle", () => {
  test("production bundle refuses to start on an unverified host, and has no development mode", () => {
    build("--variant", "production");
    const prod = runBundle("production", config("production"));
    assert.notEqual(prod.status, 0);
    assert.match(prod.stderr, /ISOLATION_UNAVAILABLE|refusing to start in production/);
    const dev = runBundle("production", config("development"));
    assert.notEqual(dev.status, 0);
    assert.match(dev.stderr, /DEV_MODE_REFUSED|development mode is not available/);
  });

  test("the manifest names every component with a hash and states each platform's status separately", () => {
    const manifest = JSON.parse(readFileSync(dist("production", "MANIFEST.json"), "utf8"));
    assert.equal(manifest.protocol, "praxis.approval-service.v1");
    for (const entry of Object.values(manifest.components)) assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.platforms.darwin.tested, /BLOCKED pending operator/);
    assert.match(manifest.platforms.linux.tested, /LINUX-CONTAINER/);
    assert.match(manifest.platforms.linux.tested, /systemd itself .* NOT exercised/);
    assert.match(manifest.platforms.win32.tested, /^UNTESTED/);
  });
});

describe("Linux and Windows packages (mechanics only: the Windows package is built with a stand-in node.exe and is never to be installed)", () => {
  test("the Linux tarball is self-contained, checksummed, and its installer passes a syntax check and a dry run of the argument handling", () => {
    const dir = mkdtempSync("/tmp/pas-lx-");
    const fakeNode = join(dir, "node");
    writeFileSync(fakeNode, "#!/bin/sh\necho v22.0.0\n", { mode: 0o755 });
    const result = build("--variant", "production", "--linux-tar", "--linux-node", fakeNode, "--linux-arch", "arm64", "--linux-node-version", "v22.0.0");
    assert.ok(result.linuxTar.endsWith("-linux-arm64.tar.gz"));
    execFileSync("tar", ["-xzf", result.linuxTar, "-C", dir]);
    const pkg = join(dir, readdirSync(dir).find((f) => f.startsWith("praxis-approval-service-")));
    const sums = readFileSync(join(pkg, "SHA256SUMS"), "utf8");
    for (const f of ["install.sh", "praxis-approval.service", "MANIFEST.json", "payload/praxis-approval-service.mjs", "payload/node/bin/node"]) assert.ok(sums.includes(f), f);
    execFileSync("sh", ["-n", join(pkg, "install.sh")]);
    const manifest = JSON.parse(readFileSync(join(pkg, "MANIFEST.json"), "utf8"));
    assert.equal(manifest.linuxArch, "arm64");
    assert.equal(spawnSync("sh", [join(pkg, "install.sh"), "bogus"], { encoding: "utf8" }).status, 2);
    const unit = readFileSync(join(pkg, "praxis-approval.service"), "utf8");
    for (const must of ["User=praxis-approval", "NoNewPrivileges=true", "ProtectSystem=strict", "CapabilityBoundingSet=", "RestrictAddressFamilies=", "PRAXIS_BUNDLE_KIND=production", "current/node/bin/node"]) assert.ok(unit.includes(must), must);
    assert.ok(!/LimitNOFILE=infinity|User=root/.test(unit));
  });

  test("the Windows package builds with checksums, the installer, the service host source and the platform manifest", () => {
    const dir = mkdtempSync("/tmp/pas-win-");
    const fakeNode = join(dir, "node.exe");
    writeFileSync(fakeNode, "MZ stand-in");
    const result = build("--variant", "production", "--windows-zip", "--windows-node", fakeNode, "--windows-arch", "x64", "--windows-node-version", "v22.0.0");
    execFileSync("unzip", ["-q", result.windowsZip, "-d", dir]);
    const pkg = join(dir, readdirSync(dir).find((f) => f.startsWith("praxis-approval-service-")));
    const sums = readFileSync(join(pkg, "SHA256SUMS"), "utf8");
    for (const f of ["install.ps1", "ServiceHost.cs", "payload\\node\\node.exe"]) assert.ok(sums.includes(f), f);
    const installer = readFileSync(join(pkg, "install.ps1"), "utf8");
    for (const must of ["UNTESTED", "NT SERVICE", "Get-FileHash", "Assert-Admin", "-AllowDowngrade", "Do-Backup", "Do-Rollback"]) assert.ok(installer.includes(must), must);
    const host = readFileSync(join(pkg, "ServiceHost.cs"), "utf8");
    for (const must of ["(D;;GA;;;NU)", "WRITE_DAC", "NT SERVICE\\PraxisApproval", "psi.EnvironmentVariables.Clear()"]) assert.ok(host.includes(must), must);
  });
});

describe("macOS package (built unprivileged, never installed)", { skip: process.platform !== "darwin" }, () => {
  test("payload is the expected set, a LaunchDaemon (not an agent), unsigned, and the Node runtime is honestly reported", () => {
    const result = build("--variant", "production", "--macos-pkg");
    const files = execFileSync("pkgutil", ["--payload-files", result.pkg], { encoding: "utf8" }).split("\n").filter((f) => f && !f.includes("._"));
    for (const expected of ["./Library/Application Support/Praxis/ApprovalService/code/praxis-approval-service.mjs", "./Library/Application Support/Praxis/ApprovalService/code/ctl.sh", "./Library/Application Support/Praxis/ApprovalService/code/MANIFEST.json", "./Library/LaunchDaemons/co.praxis.approval-service.plist"]) {
      assert.ok(files.includes(expected), expected);
    }
    assert.ok(!files.some((f) => /LaunchAgents/.test(f)));
    const signature = spawnSync("pkgutil", ["--check-signature", result.pkg], { encoding: "utf8" }).stdout;
    assert.match(signature, /no signature/i);
    const manifest = JSON.parse(readFileSync(dist("production", "MANIFEST.json"), "utf8"));
    assert.equal(manifest.nodeRuntime.bundled, false);
    assert.match(manifest.nodeRuntime.reason, /cannot start until one is installed/);
    // the install scripts shipped inside the package: placeholders filled, root checks and backups present
    const expanded = mkdtempSync("/tmp/pas-pkg-");
    const target = join(expanded, "x");
    execFileSync("pkgutil", ["--expand-full", result.pkg, target], { stdio: "pipe" });
    const pre = readFileSync(join(target, "Scripts/preinstall"), "utf8");
    const post = readFileSync(join(target, "Scripts/postinstall"), "utf8");
    assert.ok(!/@ARCH@|@VERSION@/.test(pre), "placeholders must be filled");
    assert.match(pre, /uname -m/);
    assert.match(pre, /a failed backup stops the installation/);
    assert.match(post, /Every ancestor of the code directory/);
    assert.match(post, /Password '\*'/);
    assert.ok(!/LaunchAgents/.test(post));
    assert.equal(manifest.macosArch, process.arch === "arm64" ? "arm64" : "x64");
    const pkgEntry = Object.entries(manifest.components).find(([name]) => name.endsWith(".pkg"))[1];
    assert.equal(pkgEntry.signed, false);
  });

  test("a Node runtime that loads libraries from elsewhere is refused as the bundled runtime", () => {
    const nodePath = process.execPath;
    const deps = execFileSync("otool", ["-L", nodePath], { encoding: "utf8" });
    if (!/@rpath|\/opt\/homebrew|\/usr\/local\/(opt|lib)/.test(deps)) return; // this machine's node is self-contained; nothing to refuse
    const attempt = spawnSync(process.execPath, [buildScript, "--variant", "production", "--macos-pkg", "--node", nodePath], { encoding: "utf8", env: { ...process.env, PRAXIS_BUILD_OUT: TEST_OUT } });
    assert.notEqual(attempt.status, 0);
    assert.match(attempt.stderr, /not self-contained/);
  });
});
