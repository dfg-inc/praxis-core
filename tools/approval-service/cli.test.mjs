/**
 * The service as a real separate process, driven through its CLI and socket. Same OS identity as the test, so the
 * isolation probe must (and does) report the host as NOT isolated: that honest answer is itself asserted here.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { callApprovalService, assessApprovalService } from "../../packages/contracts/dist/index.js";
import { freePort, git, makeRepo, stage } from "./test-harness.mjs";

const cli = fileURLToPath(new URL("./praxis-approval-service.mjs", import.meta.url));
const children = [];
after(() => children.forEach((c) => c.kill("SIGKILL")));
const run = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { code: error.status, out: String(error.stdout ?? ""), err: String(error.stderr ?? "") };
  }
};

async function startProcess() {
  const root = mkdtempSync("/tmp/pas-");
  const repo = makeRepo(root, "r");
  const port = await freePort();
  const state = join(root, "state");
  const config = join(root, "config.json");
  const endpoint = join(root, "svc.sock");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(config, JSON.stringify({ mode: "development", principal: "test", paths: { stateDir: state, endpoint, codeDir: root, configFile: config }, repositories: [{ path: repo.dir, remotes: { origin: repo.remote }, branches: ["main"] }], operator: { port, origin: `http://localhost:${port}` } }));
  const child = spawn(process.execPath, [cli, "run", "--config", config], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const banner = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]));
    });
    child.stderr.on("data", (d) => reject(new Error(String(d))));
    child.on("exit", (code) => reject(new Error(`exited ${code}`)));
  });
  return { root, repo, port, state, config, endpoint, child, banner };
}

describe("real service process", () => {
  test("starts as its own process, answers health, reports itself unisolated and in development mode", async () => {
    const p = await startProcess();
    assert.equal(p.banner.ok, true);
    const health = (await callApprovalService({ op: "health" }, { endpoint: p.endpoint })).health;
    assert.equal(health.mode, "development");
    assert.equal(health.isolation.verified, false);
    assert.ok(health.isolation.checks.length >= 5);
    assert.equal(health.auditChain.ok, true);
    const assessment = await assessApprovalService({ endpoint: p.endpoint });
    assert.equal(assessment.isolated, false, "a same-user service is never reported as isolated");
    const cliHealth = run("health", "--endpoint", p.endpoint);
    assert.equal(cliHealth.code, 0);
    const isolation = run("verify-isolation", "--config", p.config);
    assert.equal(isolation.code, 1, "the probe fails on a same-user development layout");
    const checks = JSON.parse(isolation.out).checks;
    assert.equal(checks.find((c) => c.id === "dedicated-principal").ok, false, "the configured principal is not the identity running this test");
    assert.match(checks.find((c) => c.id === "dedicated-principal").detail, /configuration expects test/);
    assert.equal(checks.find((c) => c.id === "code-protected").ok, false, "a /tmp directory is writable by others or the user");
  });

  test("a request submitted to the real process is shown on the real operator page and executes once approved", async () => {
    const p = await startProcess();
    stage(p.repo.dir, "cli.txt", "cli\n");
    const submitted = await callApprovalService({ op: "submit", operation: "git_commit", repository: p.repo.dir, workItemId: "WI-CLI", params: { message: "via cli" } }, { endpoint: p.endpoint });
    assert.equal(submitted.state, "awaiting-operator", JSON.stringify(submitted));
    const page = await (await fetch(`http://localhost:${p.port}/plan/${submitted.requestId}`)).text();
    assert.ok(page.includes("WI-CLI") && page.includes("cli.txt") && page.includes("via cli") && page.includes("Approve with authenticator"));
    const refused = await callApprovalService({ op: "execute", requestId: submitted.requestId }, { endpoint: p.endpoint });
    assert.equal(refused.code, "APPROVAL_REQUIRED");
    assert.equal(git(p.repo.dir, "rev-list", "--count", "HEAD"), "1");
  });

  test("enroll-code opens a window and the audit chain verifies from the CLI", async () => {
    const p = await startProcess();
    const enroll = run("enroll-code", "--config", p.config);
    assert.equal(enroll.code, 0);
    assert.match(enroll.out, /Enrollment code \(valid 15 minutes, one authenticator\): [a-f0-9]{16}/);
    const verified = run("audit-verify", "--config", p.config);
    assert.equal(verified.code, 0, verified.out);
    rmSync(p.root, { recursive: true, force: true });
  });
});

describe("install plans and artifacts (generated, never executed)", () => {
  test("every platform renders a plan; macOS names a launchd DAEMON with a dedicated user, not a LaunchAgent", () => {
    for (const os of ["darwin", "linux", "win32"]) {
      const plan = JSON.parse(run("install-plan", "--platform", os, "--json").out);
      assert.ok(plan.steps.length >= 3, os);
      assert.ok(plan.status.tested.length > 10);
    }
    const darwin = JSON.parse(run("install-plan", "--platform", "darwin", "--json").out);
    assert.ok(darwin.steps.some((s) => /LaunchDaemons|launchctl bootstrap system/.test(s.command)));
    assert.ok(!darwin.steps.some((s) => /LaunchAgents|gui\/\d+/.test(s.command)));
    const plist = run("render-unit", "--platform", "darwin").out;
    assert.match(plist, /<key>UserName<\/key><string>_praxisapproval<\/string>/);
    assert.ok(!/LaunchAgents/.test(plist));
    assert.equal(JSON.parse(run("install-plan", "--platform", "linux", "--json").out).status.tested.startsWith("UNTESTED"), true);
    assert.equal(JSON.parse(run("install-plan", "--platform", "win32", "--json").out).status.tested.startsWith("UNTESTED"), true);
    assert.match(run("render-unit", "--platform", "linux").out, /User=praxis-approval[\s\S]*NoNewPrivileges=true/);
  });

  test("the macOS plist is valid", () => {
    const dir = mkdtempSync("/tmp/pas-");
    writeFileSync(join(dir, "x.plist"), run("render-unit", "--platform", "darwin").out);
    try {
      execFileSync("plutil", ["-lint", join(dir, "x.plist")], { stdio: "pipe" });
    } catch (error) {
      if (error.code === "ENOENT") return; // not macOS
      throw error;
    }
    assert.ok(readFileSync(join(dir, "x.plist"), "utf8").includes(co()));
  });
});
const co = () => "co.praxis.approval-service";
