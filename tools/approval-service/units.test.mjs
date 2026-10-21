/** Focused unit tests of the pure parts: Git configuration screening, remote identity, audit scrubbing, probe logic. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { scrub } from "./lib/audit.mjs";
import { remoteIdentity } from "./lib/executor.mjs";
import { configProblems, parseConfigList } from "./lib/gitx.mjs";
import { chainProblems, posixIsolationChecks } from "./platform/common.mjs";

const cfg = (...pairs) => pairs.map(([k, v]) => [k, v]);

describe("git configuration screening", () => {
  test("a stock repository configuration is accepted", () => {
    assert.deepEqual(configProblems(cfg(["core.repositoryformatversion", "0"], ["core.filemode", "true"], ["core.bare", "false"], ["core.ignorecase", "true"], ["remote.origin.url", "/tmp/x.git"], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], ["branch.main.remote", "origin"], ["user.name", "A"], ["user.email", "a@b"])), []);
  });

  for (const [key, value] of [
    ["core.fsmonitor", "x"], ["core.hooksPath", "x"], ["core.sshCommand", "x"], ["core.pager", "x"], ["core.editor", "x"], ["core.askPass", "x"], ["core.gitProxy", "x"],
    ["credential.helper", "x"], ["credential.https://x.username", "x"], ["http.proxy", "x"], ["http.extraHeader", "Authorization: x"], ["http.sslCAInfo", "/x"],
    ["alias.x", "!x"], ["include.path", "x"], ["includeIf.gitdir:/.path", "x"], ["diff.external", "x"], ["diff.x.textconv", "x"], ["filter.x.clean", "x"], ["filter.x.process", "x"],
    ["merge.x.driver", "x"], ["gpg.program", "x"], ["gpg.ssh.program", "x"], ["commit.gpgsign", "true"], ["uploadpack.packObjectsHook", "x"], ["remote.origin.pushurl", "x"],
    ["remote.origin.proxy", "x"], ["remote.origin.receivepack", "x"], ["remote.origin.vcs", "x"], ["protocol.ext.allow", "always"], ["core.worktree", "/x"], ["core.attributesFile", "/x"],
    ["core.excludesFile", "/x"], ["extensions.worktreeConfig", "true"], ["safe.directory", "*"], ["sendemail.smtpServer", "x"], ["pager.log", "x"],
  ]) {
    test(`refuses ${key}`, () => {
      assert.ok(configProblems(cfg([key, value])).length > 0, key);
    });
  }

  test("refuses a remote URL that embeds credentials, and URL rewrites only where they could change the service's own URLs", () => {
    assert.ok(configProblems(cfg(["remote.origin.url", "https://user:secret@example.com/r.git"])).length > 0);
    assert.equal(configProblems(cfg(["remote.origin.url", "https://example.com/r.git"])).length, 0);
    assert.ok(configProblems(cfg(["url.https://evil/.insteadOf", "https://good/"]), ["https://good/r.git"]).length > 0);
    assert.equal(configProblems(cfg(["url.https://evil/.insteadOf", "https://elsewhere/"]), ["https://good/r.git"]).length, 0);
    assert.ok(configProblems(cfg(["url.https://evil/.pushInsteadOf", ""]), ["https://good/r.git"]).length > 0);
  });

  test("parses git's NUL separated config list", () => {
    assert.deepEqual(parseConfigList("core.a\ntrue\0remote.origin.url\n/x\0"), [["core.a", "true"], ["remote.origin.url", "/x"]]);
  });
});

describe("remote identity as a human reads it", () => {
  test("credentials never appear and local paths are marked as local", () => {
    assert.equal(remoteIdentity("https://tok:en@github.com/o/r.git"), "github.com/o/r");
    assert.equal(remoteIdentity("git@github.com:o/r.git"), "github.com/o/r");
    assert.equal(remoteIdentity("ssh://git@host:2222/o/r.git"), "host:2222/o/r");
    assert.equal(remoteIdentity("/srv/git/r.git"), "local-file:/srv/git/r.git");
    assert.equal(remoteIdentity("file:///srv/git/r.git"), "local-file:/srv/git/r.git");
  });
});

describe("audit scrubbing", () => {
  test("drops secret-shaped keys and redacts bearer tokens and URL credentials", () => {
    const out = scrub({ planId: "p", token: "abc", nested: { Authorization: "x", password: "y", ok: "fine" }, line: "Bearer abcdefghijklmnop and https://u:p@host/x", list: [{ secret: 1, keep: 2 }] });
    assert.deepEqual(Object.keys(out).sort(), ["line", "list", "nested", "planId"]);
    assert.deepEqual(out.nested, { ok: "fine" });
    assert.ok(!/abcdefghijklmnop|u:p@/.test(out.line));
    assert.deepEqual(out.list, [{ keep: 2 }]);
  });
});

describe("posix isolation probe", () => {
  const layout = (mode) => {
    const dir = mkdtempSync(join(process.env.HOME ?? "/tmp", ".pas-probe-"));
    const state = join(dir, "state");
    const run = join(dir, "run");
    mkdirSync(state, { mode });
    mkdirSync(run, { mode: 0o755 });
    chmodSync(state, mode);
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "config.json"), "{}", { mode: 0o644 });
    return { dir, paths: { stateDir: state, codeDir: dir, configFile: join(dir, "config.json"), endpoint: join(run, "s.sock") } };
  };

  test("a private state directory passes and a group/world readable one fails", () => {
    const good = layout(0o700);
    const checks = posixIsolationChecks({ paths: good.paths, config: {}, dockerSockets: [] });
    assert.equal(checks.find((c) => c.id === "state-private").ok, true);
    const bad = layout(0o755);
    assert.equal(posixIsolationChecks({ paths: bad.paths, config: {}, dockerSockets: [] }).find((c) => c.id === "state-private").ok, false);
  });

  test("a code directory writable by others, or inside a world-writable parent, fails", () => {
    const l = layout(0o700);
    chmodSync(l.dir, 0o777);
    assert.ok(chainProblems(l.dir, process.getuid()).length > 0);
    chmodSync(l.dir, 0o755);
    assert.ok(chainProblems("/tmp/definitely-not-there/x", process.getuid()).length >= 0);
  });

  test("hostile process inputs fail the clean-environment check", () => {
    const l = layout(0o700);
    const dirty = posixIsolationChecks({ paths: l.paths, config: {}, dockerSockets: [], env: { NODE_OPTIONS: "--require /tmp/x", PATH: "/usr/bin" }, execArgv: [] });
    assert.equal(dirty.find((c) => c.id === "clean-environment").ok, false);
    const flagged = posixIsolationChecks({ paths: l.paths, config: {}, dockerSockets: [], env: {}, execArgv: ["--inspect"] });
    assert.equal(flagged.find((c) => c.id === "clean-environment").ok, false);
    const clean = posixIsolationChecks({ paths: l.paths, config: {}, dockerSockets: [], env: { PATH: "/usr/bin" }, execArgv: [] });
    assert.equal(clean.find((c) => c.id === "clean-environment").ok, true);
  });
});
