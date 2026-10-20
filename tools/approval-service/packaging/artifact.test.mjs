/**
 * Tests of the BUILT artifacts, run unprivileged: the production bundle must fail closed on a host that is not
 * isolated and must not offer development mode; the macOS package must contain exactly the expected, root-owned
 * payload. Nothing here installs anything.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const buildScript = join(root, "tools/approval-service/packaging/build.mjs");
const dist = (variant, ...rest) => join(root, "dist/approval-service", variant, ...rest);
const build = (...args) => JSON.parse(execFileSync(process.execPath, [buildScript, ...args], { encoding: "utf8" }));

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
    assert.match(manifest.platforms.linux.tested, /^UNTESTED/);
    assert.match(manifest.platforms.win32.tested, /^UNTESTED/);
  });
});

describe("macOS package (built unprivileged, never installed)", { skip: process.platform !== "darwin" }, () => {
  test("payload is the expected set, a LaunchDaemon (not an agent), unsigned, and the Node runtime is honestly reported", () => {
    const result = build("--variant", "production", "--macos-pkg");
    const files = execFileSync("pkgutil", ["--payload-files", result.pkg], { encoding: "utf8" }).split("\n").filter((f) => f && !f.includes("._"));
    for (const expected of ["./usr/local/libexec/praxis-approval-service/praxis-approval-service.mjs", "./usr/local/libexec/praxis-approval-service/uninstall.sh", "./Library/LaunchDaemons/co.praxis.approval-service.plist"]) {
      assert.ok(files.includes(expected), expected);
    }
    assert.ok(!files.some((f) => /LaunchAgents/.test(f)));
    const signature = spawnSync("pkgutil", ["--check-signature", result.pkg], { encoding: "utf8" }).stdout;
    assert.match(signature, /no signature/i);
    const manifest = JSON.parse(readFileSync(dist("production", "MANIFEST.json"), "utf8"));
    assert.equal(manifest.nodeRuntime.bundled, false);
    assert.match(manifest.nodeRuntime.reason, /cannot start until one is installed/);
    const pkgEntry = Object.entries(manifest.components).find(([name]) => name.endsWith(".pkg"))[1];
    assert.equal(pkgEntry.signed, false);
  });

  test("a Node runtime that loads libraries from elsewhere is refused as the bundled runtime", () => {
    const nodePath = process.execPath;
    const deps = execFileSync("otool", ["-L", nodePath], { encoding: "utf8" });
    if (!/@rpath|\/opt\/homebrew|\/usr\/local\/(opt|lib)/.test(deps)) return; // this machine's node is self-contained; nothing to refuse
    const attempt = spawnSync(process.execPath, [buildScript, "--variant", "production", "--macos-pkg", "--node", nodePath], { encoding: "utf8" });
    assert.notEqual(attempt.status, 0);
    assert.match(attempt.stderr, /not self-contained/);
  });
});
