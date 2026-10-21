/**
 * The macOS installer scripts (preinstall, postinstall, ctl.sh), executed WITHOUT privileges in a sandbox.
 *
 * WHAT THIS IS: the real scripts, with their absolute paths rewritten into a temporary directory and with the privileged
 * commands (dscl, dseditgroup, launchctl, chown, id, sw_vers, uname, and `install -o/-g`) replaced by logging shims. Files and
 * directories, modes, backups, copies and refusals are REAL; account creation, ownership changes and launchd calls are
 * SIMULATED (only recorded). So this proves the scripts' logic and the exact privileged commands they would issue. It does
 * NOT prove what macOS does when they run as root: that is the owner's installation (MACOS-ACCEPTANCE.md, step A).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const REAL_BASE = "/Library/Application Support/Praxis/ApprovalService";
const REAL_PLIST = "/Library/LaunchDaemons/co.praxis.approval-service.plist";
const REAL_LOG = "/var/log/praxis-approval";

const SHIMS = {
  // account database in $SB/db: users (name uid), groups (name gid)
  dscl: `#!/bin/bash
echo "dscl $*" >> "$SB/calls.log"
db="$SB/db"; mkdir -p "$db"; touch "$db/users" "$db/groups"
case "$*" in
  *"-list /Users UniqueID"*) awk '{print $1" "$2}' "$db/users" ;;
  *"-list /Groups PrimaryGroupID"*) awk '{print $1" "$2}' "$db/groups" ;;
  *"-read /Users/"*"UniqueID"*) n=\${3#/Users/}; if grep -q "^$n " "$db/users"; then echo "UniqueID: $(grep "^$n " "$db/users" | cut -d' ' -f2)"; exit 0; else exit 1; fi ;;
  *"-read /Users/"*) n=\${3#/Users/}; grep -q "^$n " "$db/users"; exit $? ;;
  *"-read /Groups/"*) n=\${3#/Groups/}; if grep -q "^$n " "$db/groups"; then echo "PrimaryGroupID: $(grep "^$n " "$db/groups" | cut -d' ' -f2)"; exit 0; else exit 1; fi ;;
  *"-create /Users/"*" UniqueID "*) n=\${3#/Users/}; echo "$n $5" >> "$db/users" ;;
  *"-delete /Users/"*) n=\${3#/Users/}; grep -v "^$n " "$db/users" > "$db/u.tmp"; mv "$db/u.tmp" "$db/users" ;;
  *"-delete /Groups/"*) n=\${3#/Groups/}; grep -v "^$n " "$db/groups" > "$db/g.tmp"; mv "$db/g.tmp" "$db/groups" ;;
  *) : ;;
esac
exit 0
`,
  dseditgroup: `#!/bin/bash
echo "dseditgroup $*" >> "$SB/calls.log"
args=("$@"); id=""; name="\${args[\${#args[@]}-1]}"
for ((i=0;i<\${#args[@]};i++)); do [ "\${args[i]}" = "-i" ] && id="\${args[i+1]}"; done
mkdir -p "$SB/db"; echo "$name $id" >> "$SB/db/groups"
`,
  launchctl: `#!/bin/bash
echo "launchctl $*" >> "$SB/calls.log"
[ "$1" = bootout ] && [ -n "$SHIM_BOOTOUT_FAILS" ] && exit 1
exit 0
`,
  chown: `#!/bin/bash
echo "chown $*" >> "$SB/calls.log"
exit 0
`,
  id: `#!/bin/bash
[ "$1" = "-u" ] && { echo "\${SHIM_UID:-0}"; exit 0; }
exec /usr/bin/id "$@"
`,
  sw_vers: `#!/bin/bash
echo "\${SHIM_MACOS:-14.5}"
`,
  uname: `#!/bin/bash
[ "$1" = "-m" ] && { echo "\${SHIM_ARCH:-arm64}"; exit 0; }
exec /usr/bin/uname "$@"
`,
  // BSD stat, except that ownership of anything inside the sandbox or above it is root (per $SB/.owners overrides), and permissions of paths above the sandbox are 755
  stat: `#!/bin/bash
fmt="$2"; path="$3"
if [ "$1" = "-f" ]; then
  case "$fmt" in
    %u) o=$(grep -F "$path " "$SB/.owners" 2>/dev/null | head -n1 | cut -d' ' -f2); echo "\${o:-0}"; exit 0 ;;
    %Lp) case "$path" in "$SB"*) /usr/bin/stat -f %Lp "$path" ;; *) echo 755 ;; esac; exit 0 ;;
  esac
fi
exec /usr/bin/stat "$@"
`,
  install: `#!/bin/bash
echo "install $*" >> "$SB/calls.log"
out=(); skip=0
for a in "$@"; do
  if [ $skip = 1 ]; then skip=0; continue; fi
  case "$a" in -o|-g) skip=1 ;; *) out+=("$a") ;; esac
done
exec /usr/bin/install "\${out[@]}"
`,
  git: `#!/bin/bash
[ -n "$SHIM_NO_GIT" ] && { echo "xcode-select: note: no developer tools were found" >&2; exit 1; }
exec /usr/bin/git "$@"
`,
  tar: `#!/bin/bash
[ -n "$SHIM_TAR_FAILS" ] && [ "$1" = "-C" ] && [ "$3" = "-czf" ] && { echo "tar: simulated failure" >&2; exit 1; }
exec /usr/bin/tar "$@"
`,
};

/** A fresh sandbox: rewritten copies of the three scripts and the shim directory. */
function sandbox({ arch = "arm64", version = "9.9.9" } = {}) {
  const sb = realpathSync(mkdtempSync("/tmp/pas-mac-"));
  const base = join(sb, "Library/Application Support/Praxis/ApprovalService");
  const plist = join(sb, "Library/LaunchDaemons/co.praxis.approval-service.plist");
  const log = join(sb, "var/log/praxis-approval");
  mkdirSync(join(sb, "Library/LaunchDaemons"), { recursive: true });
  mkdirSync(join(sb, "shims"));
  for (const [name, body] of Object.entries(SHIMS)) {
    writeFileSync(join(sb, "shims", name), body, { mode: 0o755 });
  }
  const rewrite = (text) => text.replaceAll(REAL_BASE, base).replaceAll(REAL_PLIST, plist).replaceAll(REAL_LOG, log).replaceAll("/usr/bin/git", join(sb, "shims/git")).replaceAll("@ARCH@", arch).replaceAll("@VERSION@", version);
  const scripts = {};
  for (const [key, file] of [["pre", "macos-preinstall.sh"], ["post", "macos-postinstall.sh"], ["ctl", "macos-ctl.sh"]]) {
    const path = join(sb, `${key}.sh`);
    writeFileSync(path, rewrite(readFileSync(join(here, file), "utf8")), { mode: 0o755 });
    scripts[key] = path;
  }
  writeFileSync(plist, "<plist/>");
  const env = { PATH: `${join(sb, "shims")}:/usr/bin:/bin:/usr/sbin:/sbin`, SB: sb, HOME: sb };
  const run = (script, args = [], extra = {}) => spawnSync("/bin/sh", [scripts[script], ...args], { encoding: "utf8", env: { ...env, ...extra }, cwd: sb });
  const calls = () => (existsSync(join(sb, "calls.log")) ? readFileSync(join(sb, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
  const mode = (path) => (statSync(path).mode & 0o7777).toString(8);
  return { sb, base, plist, log, run, calls, mode, env, cleanup: () => rmSync(sb, { recursive: true, force: true }) };
}

/** A pretend installed payload (what the package would have laid down) under the sandbox. */
function seedCode(s, version = "9.9.9") {
  const code = join(s.base, "code");
  mkdirSync(join(code, "node/bin"), { recursive: true });
  writeFileSync(join(code, "MANIFEST.json"), JSON.stringify({ version }, null, 2));
  writeFileSync(join(code, "praxis-approval-service.mjs"), "// service\n");
  writeFileSync(join(code, "node/bin/node"), "#!/bin/sh\necho stand-in\n", { mode: 0o755 });
  return code;
}

describe("preinstall (sandboxed; privileged commands simulated)", { skip: process.platform !== "darwin" }, () => {
  test("refuses the wrong architecture, an old macOS, a symbolic-link base and a base that is not root-owned", () => {
    for (const [label, opts, env, expect] of [
      ["wrong arch", { arch: "arm64" }, { SHIM_ARCH: "x86_64" }, /this package is for arm64, this Mac is x86_64/],
      ["old macOS", {}, { SHIM_MACOS: "11.7" }, /macOS 12 or newer/],
    ]) {
      const s = sandbox(opts);
      try {
        const r = s.run("pre", ["pkg", "dest", "/", "/"], env);
        assert.notEqual(r.status, 0, label);
        assert.match(r.stderr, expect, label);
      } finally {
        s.cleanup();
      }
    }
    const link = sandbox();
    try {
      mkdirSync(join(link.sb, "elsewhere"));
      mkdirSync(join(link.base, ".."), { recursive: true });
      symlinkSync(join(link.sb, "elsewhere"), link.base);
      const r = link.run("pre", ["pkg", "dest", "/", "/"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /symbolic link/);
    } finally {
      link.cleanup();
    }
    const owned = sandbox();
    try {
      mkdirSync(owned.base, { recursive: true });
      writeFileSync(join(owned.sb, ".owners"), `${owned.base} 501\n`);
      const r = owned.run("pre", ["pkg", "dest", "/", "/"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /not owned by root/);
    } finally {
      owned.cleanup();
    }
  });

  test("refuses when /usr/bin/git does not run (no Command Line Tools): the service could not start", () => {
    const s = sandbox();
    try {
      const r = s.run("pre", ["pkg", "dest", "/", "/"], { SHIM_NO_GIT: "1" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /xcode-select --install/);
    } finally {
      s.cleanup();
    }
  });

  test("refuses a target volume other than the boot volume", () => {
    const s = sandbox();
    try {
      const r = s.run("pre", ["pkg", "dest", "/Volumes/Other", "/Volumes/Other"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /boot volume only/);
    } finally {
      s.cleanup();
    }
  });

  test("a fresh install makes no backup; an upgrade backs up code, state and config root-only; a failed backup stops the install", () => {
    const fresh = sandbox();
    try {
      assert.equal(fresh.run("pre", ["pkg", "dest", "/", "/"]).status, 0);
      assert.ok(!existsSync(join(fresh.base, "backups")), "nothing to back up on a fresh machine");
    } finally {
      fresh.cleanup();
    }
    const s = sandbox({ version: "9.9.9" });
    try {
      const code = seedCode(s, "9.9.8");
      mkdirSync(join(s.base, "state/trusted"), { recursive: true });
      writeFileSync(join(s.base, "state/trusted/private.pem"), "SECRET-KEY\n");
      writeFileSync(join(s.base, "config.json"), '{"mode":"production"}\n');
      const r = s.run("pre", ["pkg", "dest", "/", "/"]);
      assert.equal(r.status, 0, r.stderr);
      const backups = join(s.base, "backups");
      assert.equal(s.mode(backups), "700");
      const [stamp] = readdirSync(backups);
      const dir = join(backups, stamp);
      assert.equal(s.mode(dir), "700");
      assert.equal(s.mode(join(dir, "state-and-config.tgz")), "600", "the archive holds the signing key and must not be readable by others");
      assert.equal(readFileSync(join(dir, "version"), "utf8").trim(), "9.9.8");
      assert.ok(existsSync(join(dir, "code/praxis-approval-service.mjs")));
      const listing = execFileSync("/usr/bin/tar", ["-tzf", join(dir, "state-and-config.tgz")], { encoding: "utf8" });
      assert.match(listing, /state\/trusted\/private\.pem/);
      assert.match(listing, /config\.json/);
      assert.equal(readFileSync(join(code, "MANIFEST.json"), "utf8").includes("9.9.8"), true, "the installed code is untouched by preinstall");
      // a failing backup aborts, and the live state is still there
      const failing = s.run("pre", ["pkg", "dest", "/", "/"], { SHIM_TAR_FAILS: "1" });
      assert.notEqual(failing.status, 0, "an upgrade must never go on without a backup of the approval record");
      assert.ok(existsSync(join(s.base, "state/trusted/private.pem")));
    } finally {
      s.cleanup();
    }
  });

  test("a downgrade is refused unless the owner creates allow-downgrade; only the five newest backups are kept", () => {
    const s = sandbox({ version: "1.0.0" });
    try {
      seedCode(s, "2.0.0");
      mkdirSync(join(s.base, "state"), { recursive: true });
      const refused = s.run("pre", ["pkg", "dest", "/", "/"]);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /newer than 1\.0\.0/);
      writeFileSync(join(s.base, "allow-downgrade"), "");
      const backups = join(s.base, "backups");
      mkdirSync(backups, { recursive: true });
      for (let i = 1; i <= 8; i += 1) mkdirSync(join(backups, `2026010${i}000000`));
      assert.equal(s.run("pre", ["pkg", "dest", "/", "/"]).status, 0);
      const kept = readdirSync(backups).sort();
      assert.equal(kept.length, 5, `retention: ${kept.join(",")}`);
      assert.ok(!kept.includes("20260101000000") && !kept.includes("20260103000000"), "the oldest are removed");
    } finally {
      s.cleanup();
    }
  });
});

describe("postinstall (sandboxed; privileged commands simulated)", { skip: process.platform !== "darwin" }, () => {
  const ready = (s) => {
    const code = seedCode(s);
    return code;
  };

  test("creates the isolated account and the directories with exactly the intended owners and modes, and starts the daemon", () => {
    const s = sandbox();
    try {
      ready(s);
      const r = s.run("post", ["pkg", "dest", "/", "/"]);
      assert.equal(r.status, 0, r.stderr);
      const calls = s.calls().join("\n");
      // the account: no shell, no home, no password, hidden, never a login, group = user, id free in both directories
      assert.match(calls, /dseditgroup -o create -r Praxis Approval Service -i 200 _praxisapproval/);
      for (const attribute of ["UserShell /usr/bin/false", "NFSHomeDirectory /var/empty", "Password *", "IsHidden 1", "UniqueID 200", "PrimaryGroupID 200"]) {
        assert.ok(calls.includes(`dscl . -create /Users/_praxisapproval ${attribute}`), attribute);
      }
      assert.ok(!/admin|sudo|-append .*GroupMembership/.test(calls), "the account is added to no other group");
      // directories: owner and mode as requested of install(1)
      assert.match(calls, /install -d -o _praxisapproval -g _praxisapproval -m 0700 .*\/state/);
      assert.match(calls, /install -d -o _praxisapproval -g _praxisapproval -m 0755 .*\/run/);
      assert.match(calls, /install -d -o _praxisapproval -g _praxisapproval -m 0750 .*praxis-approval/);
      assert.equal(s.mode(join(s.base, "state")), "700");
      assert.equal(s.mode(join(s.base, "run")), "755");
      assert.equal(s.mode(s.log), "750");
      // configuration: created root-owned 0644 with an empty allow-list, production mode
      const config = JSON.parse(readFileSync(join(s.base, "config.json"), "utf8"));
      assert.deepEqual(config, { mode: "production", principal: "_praxisapproval", repositories: [], operator: { port: 8780, origin: "http://localhost:8780" } });
      assert.equal(s.mode(join(s.base, "config.json")), "644");
      assert.match(calls, /chown root:wheel .*config\.json/);
      assert.match(calls, /chown -R root:wheel .*\/code/);
      assert.match(calls, /chown root:wheel .*co\.praxis\.approval-service\.plist/);
      assert.match(calls, /launchctl bootstrap system .*co\.praxis\.approval-service\.plist/);
      assert.ok(calls.indexOf("launchctl bootout") < calls.indexOf("launchctl bootstrap"), "an existing instance is stopped first");
    } finally {
      s.cleanup();
    }
  });

  test("an existing configuration is kept byte for byte; group and other write bits are stripped from the code; ids are taken from a free pair", () => {
    const s = sandbox();
    try {
      const code = ready(s);
      mkdirSync(s.base, { recursive: true });
      writeFileSync(join(s.base, "config.json"), '{"mode":"production","repositories":[{"path":"/r","branches":["main"]}]}\n', { mode: 0o600 });
      const before = readFileSync(join(s.base, "config.json"), "utf8");
      chmodSync(join(code, "praxis-approval-service.mjs"), 0o666);
      // 200-204 are taken: some by users, some by groups
      mkdirSync(join(s.sb, "db"), { recursive: true });
      writeFileSync(join(s.sb, "db/users"), "alice 200\nbob 201\ncarol 203\n");
      writeFileSync(join(s.sb, "db/groups"), "staff 202\nteam 203\nwheel 204\n");
      const r = s.run("post", ["pkg", "dest", "/", "/"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(s.base, "config.json"), "utf8"), before);
      assert.equal(s.mode(join(code, "praxis-approval-service.mjs")) & 0o022, 0, "the code is not writable by group or others");
      assert.match(s.calls().join("\n"), /UniqueID 205/);
    } finally {
      s.cleanup();
    }
  });

  test("refuses when an ancestor of the code directory is writable by others, not owned by root, or a symbolic link", () => {
    for (const [label, tamper, expect] of [
      ["group/other writable ancestor", (s) => chmodSync(join(s.sb, "Library/Application Support/Praxis"), 0o777), /writable by group or others/],
      ["ancestor owned by a user", (s) => writeFileSync(join(s.sb, ".owners"), `${join(s.sb, "Library/Application Support")} 501\n`), /not owned by root/],
      ["the code directory is a link", (s) => { const code = join(s.base, "code"); const away = join(s.sb, "away"); cpSync(code, away, { recursive: true }); rmSync(code, { recursive: true }); symlinkSync(away, code); }, /symbolic link/],
    ]) {
      const s = sandbox();
      try {
        ready(s);
        tamper(s);
        const r = s.run("post", ["pkg", "dest", "/", "/"]);
        assert.notEqual(r.status, 0, label);
        assert.match(r.stderr, expect, label);
        assert.ok(!s.calls().some((c) => c.startsWith("launchctl bootstrap")), `${label}: the daemon must not be started`);
        assert.ok(!s.calls().some((c) => c.startsWith("dscl . -create")), `${label}: no account is created before the code location is proven safe`);
      } finally {
        s.cleanup();
      }
    }
  });

  test("a group named like the service account without the account is refused, and an existing account is reused", () => {
    const s = sandbox();
    try {
      ready(s);
      mkdirSync(join(s.sb, "db"), { recursive: true });
      writeFileSync(join(s.sb, "db/groups"), "_praxisapproval 300\n");
      const r = s.run("post", ["pkg", "dest", "/", "/"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /exists without the matching account/);
    } finally {
      s.cleanup();
    }
    const again = sandbox();
    try {
      ready(again);
      assert.equal(again.run("post", ["pkg", "dest", "/", "/"]).status, 0);
      const first = again.calls().filter((c) => c.startsWith("dscl . -create /Users/_praxisapproval UniqueID")).length;
      assert.equal(again.run("post", ["pkg", "dest", "/", "/"]).status, 0, "a second run (an upgrade) succeeds");
      assert.equal(again.calls().filter((c) => c.startsWith("dscl . -create /Users/_praxisapproval UniqueID")).length, first, "the account is created once");
    } finally {
      again.cleanup();
    }
  });
});

describe("ctl.sh health, backup, rollback, uninstall (sandboxed)", { skip: process.platform !== "darwin" }, () => {
  const withNode = (s, healthJson) => {
    const code = seedCode(s);
    writeFileSync(join(code, "node/bin/node"), `#!/bin/sh\ncat <<'JSON'\n${healthJson}\nJSON\n`, { mode: 0o755 });
    return code;
  };
  const health = (over = {}) => JSON.stringify({ ok: true, health: { mode: "production", isolation: { verified: true }, integrity: { ok: true }, ...over } }, null, 2);

  test("health demands production mode, verified isolation and ok integrity", () => {
    const good = sandbox();
    try {
      withNode(good, health());
      const r = good.run("ctl", ["health"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /healthy/);
    } finally {
      good.cleanup();
    }
    for (const [over, expect] of [[{ mode: "development" }, /not in production mode/], [{ isolation: { verified: false } }, /isolation is not verified/], [{ integrity: { ok: false } }, /integrity problem/]]) {
      const s = sandbox();
      try {
        withNode(s, health(over));
        const r = s.run("ctl", ["health"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, expect);
      } finally {
        s.cleanup();
      }
    }
  });

  test("every management command except health refuses to run unless root", () => {
    const s = sandbox();
    try {
      seedCode(s);
      for (const command of ["backup", "rollback", "uninstall"]) {
        const r = s.run("ctl", [command], { SHIM_UID: "501" });
        assert.notEqual(r.status, 0, command);
        assert.match(r.stderr, /run as root/);
      }
    } finally {
      s.cleanup();
    }
  });

  test("backup is root-only and complete; rollback restores the previous code and restarts; state is untouched unless asked", () => {
    const s = sandbox();
    try {
      const code = seedCode(s, "1.0.0");
      mkdirSync(join(s.base, "state/ledger"), { recursive: true });
      writeFileSync(join(s.base, "state/ledger/c-1.json"), "{}");
      writeFileSync(join(s.base, "config.json"), "{}\n");
      assert.equal(s.run("ctl", ["backup"]).status, 0);
      const backups = join(s.base, "backups");
      const [stamp] = readdirSync(backups);
      assert.equal(s.mode(join(backups, stamp)), "700");
      assert.equal(s.mode(join(backups, stamp, "state-and-config.tgz")), "600");
      // the code on disk is "upgraded", then rolled back
      writeFileSync(join(code, "MANIFEST.json"), JSON.stringify({ version: "2.0.0" }));
      writeFileSync(join(s.base, "state/ledger/c-2.json"), "{}");
      const r = s.run("ctl", ["rollback"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(readFileSync(join(code, "MANIFEST.json"), "utf8"), /1\.0\.0/);
      assert.ok(existsSync(join(s.base, "state/ledger/c-2.json")), "rollback does not rewind the ledger unless asked");
      const calls = s.calls().join("\n");
      assert.match(calls, /chown -R root:wheel .*\/code/);
      assert.match(calls, /launchctl bootstrap system/);
      // a rollback with nothing to roll back to
      const empty = sandbox();
      try {
        seedCode(empty);
        const none = empty.run("ctl", ["rollback"]);
        assert.notEqual(none.status, 0);
        assert.match(none.stderr, /no backup to roll back to/);
      } finally {
        empty.cleanup();
      }
    } finally {
      s.cleanup();
    }
  });

  test("uninstall keeps state, configuration and backups; --purge removes them and the account, and a failed backup stops both", () => {
    const keep = sandbox();
    try {
      seedCode(keep);
      mkdirSync(join(keep.base, "state"), { recursive: true });
      writeFileSync(join(keep.base, "config.json"), "{}\n");
      const r = keep.run("ctl", ["uninstall"]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(join(keep.base, "code")) && !existsSync(keep.plist));
      assert.ok(existsSync(join(keep.base, "state")) && existsSync(join(keep.base, "config.json")));
      assert.equal(readdirSync(join(keep.base, "backups")).length, 1, "a backup is taken before anything is removed");
      assert.ok(keep.calls().some((c) => /^launchctl bootout/.test(c)));
      assert.ok(!keep.calls().some((c) => c.startsWith("dscl . -delete")), "the account stays without --purge");
    } finally {
      keep.cleanup();
    }
    const purge = sandbox();
    try {
      seedCode(purge);
      mkdirSync(join(purge.base, "state"), { recursive: true });
      writeFileSync(join(purge.base, "config.json"), "{}\n");
      const r = purge.run("ctl", ["uninstall", "--purge"]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(join(purge.base, "state")) && !existsSync(join(purge.base, "config.json")));
      assert.ok(existsSync(join(purge.base, "backups")), "the backup survives a purge");
      const calls = purge.calls().join("\n");
      assert.match(calls, /dscl \. -delete \/Users\/_praxisapproval/);
      assert.match(calls, /dscl \. -delete \/Groups\/_praxisapproval/);
    } finally {
      purge.cleanup();
    }
    const failing = sandbox();
    try {
      seedCode(failing);
      mkdirSync(join(failing.base, "state"), { recursive: true });
      writeFileSync(join(failing.base, "config.json"), "{}\n");
      for (const args of [["uninstall"], ["uninstall", "--purge"]]) {
        const r = failing.run("ctl", args, { SHIM_TAR_FAILS: "1" });
        assert.notEqual(r.status, 0, args.join(" "));
        assert.ok(existsSync(join(failing.base, "state")), `${args.join(" ")}: state must survive a failed backup`);
        assert.ok(existsSync(join(failing.base, "code")), `${args.join(" ")}: nothing is removed after a failed backup`);
      }
    } finally {
      failing.cleanup();
    }
  });
});

describe("the built package and its launchd configuration (unprivileged inspection)", { skip: process.platform !== "darwin" }, () => {
  const pkgDir = join(here, "../../../dist/approval-service/production");
  const pkg = existsSync(pkgDir) ? readdirSync(pkgDir).find((f) => f.endsWith("-macos-arm64.pkg")) : undefined;
  const inspect = { skip: !pkg };

  test("plist: a system daemon as the role account with no agent-reachable trigger", inspect, () => {
    const json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(pkgDir, "macos/co.praxis.approval-service.plist")], { encoding: "utf8" }));
    assert.equal(json.Label, "co.praxis.approval-service");
    assert.equal(json.UserName, "_praxisapproval");
    assert.equal(json.GroupName, "_praxisapproval");
    assert.equal(json.RunAtLoad, true);
    assert.equal(json.KeepAlive, true);
    assert.equal(json.Umask, 18);
    assert.equal(json.ProcessType, "Background");
    assert.ok(json.ProgramArguments[0].startsWith("/Library/Application Support/Praxis/ApprovalService/code/"), "the program is inside the root-owned code directory");
    assert.ok(json.ProgramArguments[1].startsWith("/Library/Application Support/Praxis/ApprovalService/code/"));
    assert.equal(json.ProgramArguments[3], "--config");
    assert.equal(json.ProgramArguments[4], "/Library/Application Support/Praxis/ApprovalService/config.json");
    for (const forbidden of ["Sockets", "WatchPaths", "QueueDirectories", "StartOnMount", "inetdCompatibility", "LaunchOnlyOnce", "MachServices", "UserEnvironmentVariables"]) assert.ok(!(forbidden in json), `${forbidden} would give another party a way to start or steer the daemon`);
    assert.deepEqual(Object.keys(json.EnvironmentVariables).sort(), ["PATH", "PRAXIS_BUNDLE_KIND"]);
    assert.equal(json.EnvironmentVariables.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.ok(json.StandardOutPath.startsWith("/var/log/praxis-approval/"));
    assert.ok(!/LaunchAgents/.test(JSON.stringify(json)));
  });

  test("payload: exactly the expected files, all root:wheel, nothing group/other-writable, no links, no set-id, node signature intact", inspect, () => {
    const file = join(pkgDir, pkg);
    const target = join(mkdtempSync("/tmp/pas-pkgi-"), "x");
    execFileSync("pkgutil", ["--expand-full", file, target], { stdio: "pipe" });
    const bom = execFileSync("lsbom", ["-p", "MUGsf", join(target, "Bom")], { encoding: "utf8" }).split("\n").filter((l) => l && !l.includes("/._") && !l.includes("\t./._"));
    const entries = bom.map((l) => {
      const [mode, owner, , size, ...path] = l.split("\t");
      return { mode, user: owner.split("/")[0] ?? owner, owner, path: path.join("\t") };
    });
    for (const e of entries) {
      assert.match(e.mode, /^[d-]/, `${e.path}: only files and directories (no links or devices)`);
      assert.ok(!/s/.test(e.mode.slice(1, 10).replace(/[rwx-]/g, "")), `${e.path}: no set-id bits`);
      assert.equal(e.mode[5], "-", `${e.path}: not writable by group (${e.mode})`);
      assert.equal(e.mode[8], "-", `${e.path}: not writable by others (${e.mode})`);
    }
    const rows = bom.map((l) => l.split("\t"));
    for (const row of rows) assert.ok(/^root\s*$/.test(row[1]) && /^wheel\s*$/.test(row[2]), `ownership of ${row[0] ?? ""}: ${row.slice(0, 3).join(" ")}`);
    const files = bom.filter((l) => l.startsWith("-")).map((l) => l.split("\t").pop()).sort();
    assert.deepEqual(files, [
      "./Library/Application Support/Praxis/ApprovalService/code/MANIFEST.json",
      "./Library/Application Support/Praxis/ApprovalService/code/ctl.sh",
      "./Library/Application Support/Praxis/ApprovalService/code/node/bin/node",
      "./Library/Application Support/Praxis/ApprovalService/code/praxis-approval-service.mjs",
      "./Library/LaunchDaemons/co.praxis.approval-service.plist",
    ]);
    const node = join(target, "Payload/Library/Application Support/Praxis/ApprovalService/code/node/bin/node");
    execFileSync("codesign", ["--verify", "--strict", node], { stdio: "pipe" });
    assert.match(spawnSync("codesign", ["-dv", "--verbose=2", node], { encoding: "utf8" }).stderr, /TeamIdentifier=HX7739G8FX/);
    for (const script of ["preinstall", "postinstall"]) {
      const text = readFileSync(join(target, "Scripts", script), "utf8");
      assert.ok(!/@ARCH@|@VERSION@/.test(text), `${script}: placeholders filled`);
      assert.equal(statSync(join(target, "Scripts", script)).mode & 0o022, 0);
      for (const forbidden of [/\bcurl\b/, /\bwget\b/, /sudo /, /eval /, /\|\s*(ba)?sh\b/]) assert.ok(!forbidden.test(text), `${script} must not use ${forbidden}`);
    }
    rmSync(target, { recursive: true, force: true });
  });

  test("manifest and checksums describe what is in the package, the Node runtime has recorded provenance, and the bundle runs under the bundled Node", inspect, () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, "MANIFEST.json"), "utf8"));
    assert.equal(manifest.nodeRuntime.bundled, true);
    assert.match(manifest.nodeRuntime.provenance.source, /^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/node-v[\d.]+-darwin-arm64\.tar\.gz$/);
    assert.equal(manifest.nodeRuntime.provenance.checksumVerified, true);
    assert.equal(manifest.nodeRuntime.signedBy, "Developer ID Application: Node.js Foundation (HX7739G8FX)");
    assert.match(manifest.nodeRuntime.sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.macosArch, "arm64");
    const entry = Object.entries(manifest.components).find(([name]) => name.endsWith(".pkg"))[1];
    assert.equal(entry.signed, false);
    const out = spawnSync("pkgutil", ["--payload-files", join(pkgDir, pkg)], { encoding: "utf8" }).stdout;
    assert.ok(out.includes("code/node/bin/node"));
  });
});
