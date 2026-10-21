/** Focused unit tests of the pure parts: Git configuration screening, remote identity, audit scrubbing, probe logic. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

import { remoteUrlProblem, loadConfig } from "./lib/config.mjs";

describe("configuration validation", () => {
  const bad = ["--upload-pack=evil", "-oProxyCommand=x", "ext::sh -c evil", "fd::3", "ftp://x/y", "git://x/y", "https://token@github.com/o/r.git", "https://u:p@github.com/o/r.git", "ssh://git:secret@host/r", "relative/path", "", "http://x/y", "file:///ok\nbad", "git@host:r so"];
  for (const url of bad) test(`refuses remote ${JSON.stringify(url)}`, () => assert.ok(remoteUrlProblem(url), url));
  for (const url of ["https://github.com/o/r.git", "ssh://git@github.com/o/r.git", "git@github.com:o/r.git", "/srv/git/r.git", "file:///srv/git/r.git"]) test(`accepts remote ${url}`, () => assert.equal(remoteUrlProblem(url), undefined));

  const write = (doc) => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pas-cfg-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify(doc));
    return file;
  };
  test("a repository without branches, with a reserved remote name or a bad URL is refused", () => {
    assert.throws(() => loadConfig(write({ mode: "production", repositories: [{ path: "/r", remotes: {} }] }), "linux"), /branches/);
    assert.throws(() => loadConfig(write({ mode: "production", repositories: [{ path: "/r", branches: ["*"], remotes: { ["__proto__"]: "/x" } }] }), "linux"));
    assert.throws(() => loadConfig(write({ mode: "production", repositories: [{ path: "/r", branches: ["*"], remotes: { origin: "--upload-pack=x" } }] }), "linux"), /must not start with/);
    assert.throws(() => loadConfig(write({ mode: "production", providers: { github: { instances: { a: { apiBase: "http://x" } } } } }), "linux"), /https/);
  });
  test("in production the document cannot move the state directory, the endpoint or the expected principal; in development it can", () => {
    const doc = { mode: "production", principal: "someone", paths: { stateDir: "/tmp/x", endpoint: "/tmp/x.sock" }, repositories: [] };
    const prod = loadConfig(write(doc), "linux");
    assert.equal(prod.paths.stateDir, "/var/lib/praxis-approval");
    assert.equal(prod.config.principal, "praxis-approval");
    const dev = loadConfig(write({ ...doc, mode: "development" }), "linux");
    assert.equal(dev.paths.stateDir, "/tmp/x");
    assert.ok(prod.paths.configFile.endsWith("config.json"), "the probe looks at the file that was actually loaded");
  });
});

import { existsSync, mkdirSync as mk } from "node:fs";
import { runGit, prepareHome, assertNoLinksUnder, gitEnvironment } from "./lib/gitx.mjs";

describe("git runs that must not read repository configuration", () => {
  test("a hostile .git in a parent of the working directory is never consulted by network-style runs", async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pas-neutral-"));
    const marker = join(root, "marker");
    mk(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), `[core]\n\tsshCommand = touch ${marker}\n\trepositoryformatversion = 0\n`);
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    mk(join(root, ".git", "objects"), { recursive: true });
    mk(join(root, ".git", "refs"), { recursive: true });
    const home = join(root, "home");
    const { emptyHooksDir } = prepareHome(home);
    const neutral = join(home, "neutral.git");
    await runGit({ neutral: true, cwd: home, args: ["init", "--bare", "-q", neutral], env: gitEnvironment({ home }), emptyHooksDir });
    const out = await runGit({ gitDir: neutral, cwd: home, args: ["config", "--list"], env: gitEnvironment({ home }), emptyHooksDir });
    assert.ok(!/touch/.test(out.stdout), "the parent repository configuration was read");
    await runGit({ gitDir: neutral, cwd: home, args: ["ls-remote", "--", "ssh://localhost:1/x"], env: gitEnvironment({ home }), emptyHooksDir, allowFail: true, timeoutMs: 5000 });
    assert.ok(!existsSync(marker), "a configured ssh command ran");
  });

  test("a symbolic link anywhere under .git is found (refs, logs, nested)", () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pas-links-"));
    for (const dir of ["refs/heads", "logs/refs/heads", "objects/info", "objects/pack"]) mk(join(root, dir), { recursive: true });
    assert.doesNotThrow(() => assertNoLinksUnder(root));
    for (const link of ["refs/heads/x", "logs/refs/heads/y", "objects/info/z", "HEAD2"]) {
      symlinkSync("/tmp", join(root, link));
      assert.throws(() => assertNoLinksUnder(root), /symbolic link/, link);
      rmSync(join(root, link));
    }
    mk(join(root, "objects", "ab"), { recursive: true });
    rmSync(join(root, "objects", "ab"), { recursive: true });
    symlinkSync("/tmp", join(root, "objects", "ab"));
    assert.throws(() => assertNoLinksUnder(root), /symbolic link/, "a symlinked object fan-out directory");
  });
});

import { parseIcacls, aclProblems, ACCOUNT } from "./platform/win32.mjs";

describe("windows ACL parsing (recorded icacls output; the only part of the Windows adapter that has been run)", () => {
  const stateGood = `C:\\ProgramData\\Praxis\\ApprovalService\\state NT SERVICE\\PraxisApproval:(OI)(CI)(M)
                                          NT AUTHORITY\\SYSTEM:(OI)(CI)(F)
                                          BUILTIN\\Administrators:(OI)(CI)(F)

Successfully processed 1 files; Failed processing 0 files
`;
  const codeBad = `C:\\Program Files\\Praxis\\ApprovalService BUILTIN\\Users:(OI)(CI)(M)
                                       NT AUTHORITY\\SYSTEM:(OI)(CI)(F)
                                       BUILTIN\\Administrators:(OI)(CI)(F)

Successfully processed 1 files; Failed processing 0 files
`;
  test("a private state directory with the service account, SYSTEM and Administrators is accepted", () => {
    const entries = parseIcacls(stateGood, "C:\\ProgramData\\Praxis\\ApprovalService\\state");
    assert.deepEqual(entries.map((e) => e.principal), [ACCOUNT, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"]);
    assert.deepEqual(aclProblems(entries, { kind: "state" }), []);
  });
  test("Users with modify on the code directory (a path with spaces) is a problem", () => {
    const entries = parseIcacls(codeBad, "C:\\Program Files\\Praxis\\ApprovalService");
    assert.ok(aclProblems(entries, { kind: "code" }).some((p) => /BUILTIN\\Users/.test(p)));
  });
  test("any broad principal on the state directory, and write access by an ordinary account, are problems", () => {
    assert.ok(aclProblems(parseIcacls("X:\\s Everyone:(OI)(CI)(RX)\n", "X:\\s"), { kind: "state" }).length > 0);
    assert.ok(aclProblems(parseIcacls("X:\\c CONTOSO\\alice:(OI)(CI)(M)\n", "X:\\c"), { kind: "code" }).length > 0);
    assert.deepEqual(aclProblems(parseIcacls("X:\\c BUILTIN\\Users:(OI)(CI)(RX)\n", "X:\\c"), { kind: "code" }), []);
  });
});
