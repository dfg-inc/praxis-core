/**
 * The macOS installer scripts (preinstall, postinstall, ctl.sh), executed WITHOUT privileges in a sandbox, taken from the BUILT
 * PACKAGE when it exists (pkgutil --expand-full), otherwise rendered from source.
 *
 * WHAT IS REAL: the scripts' text; every file, directory, symlink, mode and macOS ACL in the sandbox (ACLs are set with the real
 * `chmod +a` on temporary directories); tar, cp, find, ls -le, awk, sed, mkdir, chmod, rm.
 * WHAT IS SIMULATED: account creation and lookup (dscl, dseditgroup, dsmemberutil keep their records in a file tree), launchctl
 * (recorded), `chown` and `install -o/-g` (recorded as ownership that `stat` then reports), id, sw_vers, uname. Absolute paths are
 * rewritten into the sandbox. So this proves the scripts' logic and the exact privileged commands they would issue. It does NOT
 * prove what macOS does when they run as root: that is the owner's installation (MACOS-ACCEPTANCE.md, step A).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderMacScript } from "./render-macos.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const REAL_BASE = "/Library/Application Support/Praxis/ApprovalService";
const REAL_PLIST = "/Library/LaunchDaemons/co.praxis.approval-service.plist";
const REAL_LOG = "/private/var/log/praxis-approval";
const REAL_LD = "/Library/LaunchDaemons";

// --- the scripts under test: from the built package when there is one -----------------------------------------------------------------
const pkgDir = join(here, "../../../dist/approval-service/production");
const builtPkg = process.env.PRAXIS_TEST_FROM_SOURCE !== "1" && existsSync(pkgDir) ? readdirSync(pkgDir).find((f) => f.endsWith("-macos-arm64.pkg")) : undefined;
let fromPkg;
function scriptText(key, arch, version) {
  if (builtPkg && process.platform === "darwin") {
    if (!fromPkg) {
      const target = join(mkdtempSync("/tmp/pas-pkgs-"), "x");
      execFileSync("pkgutil", ["--expand-full", join(pkgDir, builtPkg), target], { stdio: "pipe" });
      fromPkg = {
        pre: readFileSync(join(target, "Scripts/preinstall"), "utf8"),
        post: readFileSync(join(target, "Scripts/postinstall"), "utf8"),
        ctl: readFileSync(join(target, "Payload/Library/Application Support/Praxis/ApprovalService/code/ctl.sh"), "utf8"),
      };
    }
    // the package fixes its own version and architecture; the tests that need another one substitute them in the shipped text
    return fromPkg[key].replace(/^PKG_ARCH="[^"]*"/m, `PKG_ARCH="${arch}"`).replace(/^PKG_VERSION="[^"]*"/m, `PKG_VERSION="${version}"`);
  }
  const file = { pre: "macos-preinstall.sh", post: "macos-postinstall.sh", ctl: "macos-ctl.sh" }[key];
  return renderMacScript(file, { arch, version });
}

const SHIMS = {
  dscl: `#!/bin/bash
echo "dscl $*" >> "$SB/calls.log"
db="$SB/db"; mkdir -p "$db/Users" "$db/Groups"
shift   # the "."
op="$1"; rec="$2"; attr="$3"; val="$4"
kind=""; name=""
case "$rec" in /Users) kind=Users ;; /Groups) kind=Groups ;; /Users/*) kind=Users; name="\${rec#/Users/}" ;; /Groups/*) kind=Groups; name="\${rec#/Groups/}" ;; esac
case "$op" in
  -read)
    [ -d "$db/$kind/$name" ] || { echo "<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)"; exit 56; }
    [ -n "$attr" ] || exit 0
    if [ -f "$db/$kind/$name/$attr" ]; then
      v="$(cat "$db/$kind/$name/$attr")"
      case "$attr" in
        IsHidden|AuthenticationAuthority) echo "dsAttrTypeNative:$attr: $v" ;;      # native attributes, as real dscl prints them
        RealName) printf '%s:\n %s\n' "$attr" "$v" ;;                                # value on the next line, as real dscl prints it
        *) echo "$attr: $v" ;;
      esac
    else echo "No such key: $attr"; fi
    exit 0 ;;
  -list)
    for d in "$db/$kind"/*; do [ -d "$d" ] || continue; [ -f "$d/$attr" ] && echo "$(basename "$d") $(cat "$d/$attr")"; done
    exit 0 ;;
  -create)
    mkdir -p "$db/$kind/$name"
    [ -n "$attr" ] && printf '%s' "$val" > "$db/$kind/$name/$attr"
    exit 0 ;;
  -delete) rm -rf "$db/$kind/$name"; exit 0 ;;
  -search)
    for d in "$db/Groups"/*; do [ -f "$d/GroupMembership" ] && grep -qw "$4" "$d/GroupMembership" && echo "$(basename "$d")  GroupMembership = ( $4 )"; done
    exit 0 ;;
esac
exit 0
`,
  dseditgroup: `#!/bin/bash
echo "dseditgroup $*" >> "$SB/calls.log"
args=("$@"); id=""; real=""; name="\${args[\${#args[@]}-1]}"
for ((i=0;i<\${#args[@]};i++)); do [ "\${args[i]}" = "-i" ] && id="\${args[i+1]}"; [ "\${args[i]}" = "-r" ] && real="\${args[i+1]}"; done
mkdir -p "$SB/db/Groups/$name"; printf '%s' "$id" > "$SB/db/Groups/$name/PrimaryGroupID"; printf '%s' "$real" > "$SB/db/Groups/$name/RealName"
`,
  dsmemberutil: `#!/bin/bash
echo "dsmemberutil $*" >> "$SB/calls.log"
if grep -qw "$3" "$SB/db/admin-members" 2>/dev/null; then echo "user is a member of the group"; else echo "user is not a member of the group"; fi
`,
  launchctl: `#!/bin/bash
echo "launchctl $*" >> "$SB/calls.log"
[ "$1" = print ] && { [ -n "$SHIM_SERVICE_RUNNING" ] && exit 0 || exit 113; }
exit 0
`,
  chown: `#!/bin/bash
echo "chown $*" >> "$SB/calls.log"
rec=0; [ "$1" = "-R" ] && { rec=1; shift; }
owner="\${1%%:*}"; shift
for p in "$@"; do
  echo "$p $owner" >> "$SB/.owners"
  [ $rec = 1 ] && [ -d "$p" ] && find "$p" -mindepth 1 | while read -r f; do echo "$f $owner" >> "$SB/.owners"; done
done
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
  // ownership comes from what chown/install recorded (default root); modes of paths inside the sandbox are real, above it 755
  stat: `#!/bin/bash
fmt="$2"; path="$3"
owner_of() { grep -F -- "$1 " "$SB/.owners" 2>/dev/null | grep -v "^$1/" | tail -n1 | sed "s|^$1 ||"; }
uid_of() { case "\${1:-root}" in root) echo 0 ;; _praxisapproval) cat "$SB/db/Users/_praxisapproval/UniqueID" 2>/dev/null || echo 301 ;; [0-9]*) echo "$1" ;; *) echo 501 ;; esac; }
if [ "$1" = "-f" ] && [ "$fmt" = "%u %N" ]; then
  shift 2
  for p in "$@"; do echo "$(uid_of "$(owner_of "$p")") $p"; done
  exit 0
fi
if [ "$1" = "-f" ]; then
  owner="$(grep -F -- "$path " "$SB/.owners" 2>/dev/null | grep -v "^$path/" | tail -n1 | sed "s|^$path ||")"
  case "$fmt" in
    %Su) echo "\${owner:-root}"; exit 0 ;;
    %u) case "\${owner:-root}" in root) echo 0 ;; _praxisapproval) cat "$SB/db/Users/_praxisapproval/UniqueID" 2>/dev/null || echo 301 ;; [0-9]*) echo "$owner" ;; *) echo 501 ;; esac; exit 0 ;;
    %Lp) case "$path" in "$SB"*) /usr/bin/stat -f %Lp "$path" ;; *) echo 755 ;; esac; exit 0 ;;
  esac
fi
exec /usr/bin/stat "$@"
`,
  install: `#!/bin/bash
echo "install $*" >> "$SB/calls.log"
out=(); skip=0; owner=""; prev=""
for a in "$@"; do
  if [ $skip = 1 ]; then skip=0; [ "$prev" = "-o" ] && owner="$a"; continue; fi
  case "$a" in -o|-g) skip=1; prev="$a" ;; *) out+=("$a"); last="$a" ;; esac
done
/usr/bin/install "\${out[@]}" || exit $?
[ -n "$owner" ] && echo "$last $owner" >> "$SB/.owners"
exit 0
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

/** A fresh sandbox with the scripts (from the package), the shims and the account database. */
function sandbox({ arch = "arm64", version = "9.9.9" } = {}) {
  const sb = realpathSync(mkdtempSync("/tmp/pas-mac-"));
  const base = join(sb, "Library/Application Support/Praxis/ApprovalService");
  const ld = join(sb, "Library/LaunchDaemons");
  const plist = join(ld, "co.praxis.approval-service.plist");
  const log = join(sb, "private/var/log/praxis-approval");
  mkdirSync(ld, { recursive: true });
  mkdirSync(join(sb, "private/var/log"), { recursive: true });
  mkdirSync(join(sb, "shims"));
  for (const [name, body] of Object.entries(SHIMS)) writeFileSync(join(sb, "shims", name), body, { mode: 0o755 });
  const map = new Map([[REAL_BASE, base], [REAL_PLIST, plist], [REAL_LOG, log], [REAL_LD, ld], ["/usr/bin/git", join(sb, "shims/git")]]);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp([...map.keys()].sort((a, b) => b.length - a.length).map(esc).join("|"), "g");
  const rewrite = (text) => text.replace(pattern, (m) => map.get(m)); // one pass, so a replacement is never rewritten again
  const scripts = {};
  for (const key of ["pre", "post", "ctl"]) {
    const path = join(sb, `${key}.sh`);
    writeFileSync(path, rewrite(scriptText(key, arch, version)), { mode: 0o755 });
    scripts[key] = path;
  }
  writeFileSync(plist, "<plist/>");
  const env = { PATH: `${join(sb, "shims")}:/usr/bin:/bin:/usr/sbin:/sbin`, SB: sb, HOME: sb };
  const run = (script, args = [], extra = {}) => spawnSync("/bin/sh", [scripts[script], ...args], { encoding: "utf8", env: { ...env, ...extra }, cwd: sb });
  const calls = () => (existsSync(join(sb, "calls.log")) ? readFileSync(join(sb, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
  const mode = (path) => (statSync(path).mode & 0o7777).toString(8);
  /** Everything the installer could have changed, so "refused before changing anything" is a comparison. */
  const snapshot = () =>
    execFileSync("/bin/sh", ["-c", `cd "${sb}" && find . -mindepth 1 -path ./shims -prune -o -path ./db -prune -o \\( -name calls.log -o -name .owners -o -name 'pre.sh' -o -name 'post.sh' -o -name 'ctl.sh' \\) -prune -o -print | sort | while read -r f; do /usr/bin/stat -f '%N %Lp %z %m' "$f"; done`], { encoding: "utf8" });
  const owner = (path, name) => writeFileSync(join(sb, ".owners"), `${path} ${name}\n`, { flag: "a" });
  const acct = (kind, name, attrs) => {
    const d = join(sb, "db", kind, name);
    mkdirSync(d, { recursive: true });
    for (const [k, v] of Object.entries(attrs)) writeFileSync(join(d, k), String(v));
  };
  const goodUser = (over = {}) => acct("Users", "_praxisapproval", { RealName: "Praxis Approval Service", UniqueID: 301, PrimaryGroupID: 301, UserShell: "/usr/bin/false", NFSHomeDirectory: "/var/empty", IsHidden: 1, Password: "*", ...over });
  const goodGroup = (over = {}) => acct("Groups", "_praxisapproval", { RealName: "Praxis Approval Service", PrimaryGroupID: 301, ...over });
  const pre = (extra) => run("pre", ["pkg", "dest", "/", "/"], extra);
  const post = (extra) => run("post", ["pkg", "dest", "/", "/"], extra);
  return { sb, base, ld, plist, log, run, pre, post, calls, mode, snapshot, owner, acct, goodUser, goodGroup, env, cleanup: () => { spawnSync("chmod", ["-R", "-N", sb]); spawnSync("chmod", ["-R", "u+rwx", sb]); rmSync(sb, { recursive: true, force: true, maxRetries: 5 }); } };
}

/** What the package would have laid down: exactly the four payload files, root-controlled. */
function seedCode(s, version = "9.9.9") {
  const code = join(s.base, "code");
  mkdirSync(join(code, "node/bin"), { recursive: true });
  writeFileSync(join(code, "MANIFEST.json"), JSON.stringify({ version }, null, 2));
  writeFileSync(join(code, "praxis-approval-service.mjs"), "// service\n");
  writeFileSync(join(code, "ctl.sh"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(code, "node/bin/node"), "#!/bin/sh\necho stand-in\n", { mode: 0o755 });
  return code;
}
const ACL_WRITE = "allow add_file,add_subdirectory,delete_child,write,append";
const addAcl = (path, entry = `_www ${ACL_WRITE}`) => execFileSync("chmod", ["+a", entry, path]);
const darwin = { skip: process.platform !== "darwin" };

describe("the scripts under test are the ones in the built package", darwin, () => {
  test("the package's preinstall, postinstall and ctl.sh are exactly what the build renders from source", { skip: !builtPkg }, () => {
    for (const [key, file] of [["pre", "macos-preinstall.sh"], ["post", "macos-postinstall.sh"], ["ctl", "macos-ctl.sh"]]) {
      const manifest = JSON.parse(readFileSync(join(pkgDir, "MANIFEST.json"), "utf8"));
      assert.equal(scriptText(key, "arm64", manifest.version), renderMacScript(file, { arch: "arm64", version: manifest.version }), `${file} differs from the shipped script`);
    }
  });
});

describe("preinstall: compatibility", darwin, () => {
  test("refuses the wrong architecture, an old macOS, no Command Line Tools and a target volume other than the boot volume", () => {
    for (const [label, env, expect, args] of [
      ["wrong arch", { SHIM_ARCH: "x86_64" }, /this package is for arm64, this Mac is x86_64/],
      ["old macOS", { SHIM_MACOS: "11.7" }, /macOS 12 or newer/],
      ["no git", { SHIM_NO_GIT: "1" }, /xcode-select --install/],
      ["other volume", {}, /boot volume only/, ["pkg", "dest", "/Volumes/Other", "/Volumes/Other"]],
    ]) {
      const s = sandbox();
      try {
        const before = s.snapshot();
        const r = s.run("pre", args ?? ["pkg", "dest", "/", "/"], env);
        assert.notEqual(r.status, 0, label);
        assert.match(r.stderr, expect, label);
        assert.equal(s.snapshot(), before, `${label}: nothing may change`);
      } finally {
        s.cleanup();
      }
    }
  });
});

describe("preinstall: adversarial directories and links (all refused BEFORE any file is written)", darwin, () => {
  const refused = (label, prepare, expect) =>
    test(label, () => {
      const s = sandbox();
      try {
        mkdirSync(s.base, { recursive: true });
        prepare(s);
        const before = s.snapshot();
        const r = s.pre();
        assert.notEqual(r.status, 0, `${label}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, expect, label);
        assert.equal(s.snapshot(), before, `${label}: the sandbox must be exactly as it was`);
        assert.ok(!s.calls().some((c) => /^(dseditgroup|launchctl) /.test(c) || /^dscl \. -(create|delete)/.test(c)), `${label}: no account or service change before the refusal`);
      } finally {
        s.cleanup();
      }
    });

  // links
  refused("an ancestor of the installation directory is a symbolic link", (s) => {
    const real = join(s.sb, "elsewhere");
    mkdirSync(real);
    rmSync(join(s.sb, "Library/Application Support"), { recursive: true, force: true });
    symlinkSync(real, join(s.sb, "Library/Application Support"));
  }, /is a symbolic link/);
  refused("an ancestor is a DANGLING symbolic link", (s) => {
    rmSync(s.base, { recursive: true, force: true });
    rmSync(join(s.base, ".."), { recursive: true, force: true });
    symlinkSync(join(s.sb, "does-not-exist"), join(s.base, ".."));
  }, /dangling symbolic link/);
  refused("the installation directory itself is a symbolic link", (s) => {
    rmSync(s.base, { recursive: true, force: true });
    mkdirSync(join(s.sb, "elsewhere"));
    mkdirSync(join(s.base, ".."), { recursive: true });
    symlinkSync(join(s.sb, "elsewhere"), s.base);
  }, /is a symbolic link/);
  for (const name of ["code", "state", "run", "secrets", "anchors", "backups"]) {
    refused(`${name} is a dangling symbolic link (the installer would create through it)`, (s) => symlinkSync(join(s.sb, "nowhere"), join(s.base, name)), /dangling symbolic link/);
    refused(`${name} is a symbolic link to a real directory`, (s) => { mkdirSync(join(s.sb, "target")); symlinkSync(join(s.sb, "target"), join(s.base, name)); }, /is a symbolic link/);
  }
  refused("the log directory is a symbolic link", (s) => { mkdirSync(join(s.sb, "target")); symlinkSync(join(s.sb, "target"), s.log); }, /is a symbolic link/);
  refused("the log directory is a DANGLING symbolic link", (s) => symlinkSync(join(s.sb, "nowhere"), s.log), /dangling symbolic link/);
  refused("the LaunchDaemon destination is a dangling symbolic link (the installer would write the plist through it)", (s) => { rmSync(s.plist); symlinkSync(join(s.sb, "nowhere"), s.plist); }, /dangling symbolic link/);
  refused("the LaunchDaemon destination is a symbolic link to a file", (s) => { writeFileSync(join(s.sb, "victim"), "x"); rmSync(s.plist); symlinkSync(join(s.sb, "victim"), s.plist); }, /is a symbolic link/);
  refused("the LaunchDaemons directory is a symbolic link", (s) => { const real = join(s.sb, "fakeld"); mkdirSync(real); rmSync(s.ld, { recursive: true }); symlinkSync(real, s.ld); }, /is a symbolic link/);
  refused("the parent of the log directory is a symbolic link", (s) => { const real = join(s.sb, "fakelog"); mkdirSync(real); rmSync(join(s.sb, "private/var/log"), { recursive: true }); symlinkSync(real, join(s.sb, "private/var/log")); }, /is a symbolic link/);

  // modes
  for (const [label, bits] of [["group-writable", 0o775], ["world-writable", 0o777], ["world-writable with the sticky bit", 0o1777], ["group-writable only (g+w, not world)", 0o770]]) {
    refused(`an ancestor of the installation is ${label}`, (s) => chmodSync(join(s.sb, "Library/Application Support"), bits), /writable by group or others/);
    refused(`the installation directory is ${label}`, (s) => chmodSync(s.base, bits), /writable by group or others/);
    refused(`the LaunchDaemons directory is ${label}`, (s) => chmodSync(s.ld, bits), /writable by group or others/);
    refused(`the parent of the log directory is ${label}`, (s) => chmodSync(join(s.sb, "private/var/log"), bits), /writable by group or others/);
  }
  refused("an existing state directory is group-writable", (s) => { mkdirSync(join(s.base, "state")); chmodSync(join(s.base, "state"), 0o770); }, /writable by group or others/);
  refused("an existing run directory is world-writable", (s) => { mkdirSync(join(s.base, "run")); chmodSync(join(s.base, "run"), 0o777); }, /writable by group or others/);

  for (const bits of [0o070, 0o020, 0o007, 0o077]) refused(`an ancestor has mode ${bits.toString(8).padStart(4, "0")} (no owner bits: the check must still see the group/other bits)`, (s) => chmodSync(join(s.sb, "Library/Application Support/Praxis"), bits), /writable by group or others/);
  refused("a dangling symbolic link inside the backups directory", (s) => { mkdirSync(join(s.base, "backups")); symlinkSync(join(s.sb, "nowhere"), join(s.base, "backups/20260101000000")); }, /symbolic link/);
  refused("a hidden symbolic link inside the backups directory", (s) => { mkdirSync(join(s.base, "backups")); symlinkSync("/", join(s.base, "backups/.hidden")); }, /symbolic link/);
  refused("the existing code tree holds a file owned by an ordinary user", (s) => { const c = seedCode(s); s.owner(join(c, "praxis-approval-service.mjs"), "501"); }, /not owned by root/);
  refused("the existing code tree holds a named pipe", (s) => { const c = seedCode(s); execFileSync("mkfifo", [join(c, "pipe")]); }, /not a plain file or directory/);
  refused("allow-downgrade is a symbolic link", (s) => { symlinkSync("/etc/hosts", join(s.base, "allow-downgrade")); }, /allow-downgrade must be a plain file/);
  refused("the service's group has another member", (s) => { s.goodUser(); s.goodGroup({ GroupMembership: "_praxisapproval mallory" }); }, /another member/);

  // owners
  refused("an ancestor is owned by an ordinary user", (s) => s.owner(join(s.sb, "Library/Application Support"), "501"), /not owned by root/);
  refused("the installation directory is owned by an ordinary user", (s) => s.owner(s.base, "501"), /not owned by root/);
  refused("the code directory is owned by an ordinary user", (s) => { mkdirSync(join(s.base, "code")); s.owner(join(s.base, "code"), "501"); }, /owned by uid 501/);
  refused("the backups directory is owned by an ordinary user", (s) => { mkdirSync(join(s.base, "backups")); s.owner(join(s.base, "backups"), "501"); }, /owned by uid 501/);
  refused("the state directory is owned by an ordinary user, not the service", (s) => { s.goodUser(); s.goodGroup(); mkdirSync(join(s.base, "state")); chmodSync(join(s.base, "state"), 0o700); s.owner(join(s.base, "state"), "501"); }, /owned by uid 501/);

  // ACLs (real macOS ACLs set with chmod +a)
  refused("an ancestor has an ACL that lets someone add files", (s) => addAcl(join(s.sb, "Library/Application Support")), /ACL entry that grants write access/);
  refused("the installation directory has a write ACL", (s) => addAcl(s.base), /ACL entry that grants write access/);
  refused("the LaunchDaemons directory has a write ACL", (s) => addAcl(s.ld), /ACL entry that grants write access/);
  refused("the parent of the log directory has a write ACL", (s) => addAcl(join(s.sb, "private/var/log")), /ACL entry that grants write access/);
  refused("an existing state directory has a write ACL for someone else", (s) => { mkdirSync(join(s.base, "state")); chmodSync(join(s.base, "state"), 0o700); addAcl(join(s.base, "state")); }, /ACL entry that grants write access/);
  refused("a write ACL granting only 'delete' or 'writeattr' is also refused", (s) => addAcl(s.base, "_www allow delete,writeattr"), /ACL entry that grants write access/);
  refused("the existing code tree holds a symbolic link", (s) => { const c = seedCode(s); symlinkSync("/etc/passwd", join(c, "planted")); }, /symbolic link/);
  refused("the existing code tree holds a group-writable file", (s) => { const c = seedCode(s); chmodSync(join(c, "praxis-approval-service.mjs"), 0o664); }, /writable by group/);
  refused("the existing code tree holds a file with a write ACL", (s) => { const c = seedCode(s); addAcl(join(c, "praxis-approval-service.mjs")); }, /ACL that grants write access/);
  refused("the existing code tree holds a set-id file", (s) => { const c = seedCode(s); chmodSync(join(c, "ctl.sh"), 0o4755); }, /set-id bit/);
  refused("the backups directory holds a symbolic link", (s) => { mkdirSync(join(s.base, "backups")); symlinkSync("/", join(s.base, "backups/20260101000000")); }, /inside the backups/);

  test("harmless variations are accepted: read-only and deny ACL entries, missing directories", () => {
    const s = sandbox();
    try {
      addAcl(s.ld, "_www allow list,search,readattr,readextattr,readsecurity");
      addAcl(join(s.sb, "Library"), "group:everyone deny delete");
      const r = s.pre();
      assert.equal(r.status, 0, r.stderr);
    } finally {
      s.cleanup();
    }
  });
});

describe("preinstall: the service account is validated before anything is installed", darwin, () => {
  const refusedAccount = (label, prepare, expect) =>
    test(label, () => {
      const s = sandbox();
      try {
        prepare(s);
        const r = s.pre();
        assert.notEqual(r.status, 0, `${label}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, expect, label);
      } finally {
        s.cleanup();
      }
    });
  refusedAccount("an unrelated account with the same name is refused", (s) => s.goodUser({ RealName: "Someone Else" }), /was not created by this installer/);
  refusedAccount("an unrelated group with the same name is refused", (s) => s.goodGroup({ RealName: "Staff Stuff" }), /was not created by this installer/);
  refusedAccount("a login shell", (s) => { s.goodUser({ UserShell: "/bin/zsh" }); s.goodGroup(); }, /login shell '\/bin\/zsh'/);
  refusedAccount("a home directory", (s) => { s.goodUser({ NFSHomeDirectory: "/Users/_praxisapproval" }); s.goodGroup(); }, /home directory '\/Users\/_praxisapproval'/);
  refusedAccount("an account that is not hidden", (s) => { s.goodUser({ IsHidden: 0 }); s.goodGroup(); }, /not hidden/);
  refusedAccount("a password", (s) => { s.goodUser({ Password: "x1y2" }); s.goodGroup(); }, /has a password set/);
  refusedAccount("an authentication authority (it could log in)", (s) => { s.goodUser({ AuthenticationAuthority: ";ShadowHash;" }); s.goodGroup(); }, /authentication authority/);
  refusedAccount("membership of the admin group", (s) => { s.goodUser(); s.goodGroup(); writeFileSync(join(s.sb, "db/admin-members"), "_praxisapproval\n"); }, /member of the admin group/);
  refusedAccount("membership of another group", (s) => { s.goodUser(); s.goodGroup(); s.acct("Groups", "staff", { PrimaryGroupID: 20, GroupMembership: "root _praxisapproval" }); }, /member of another group/);
  refusedAccount("a UID outside the system range", (s) => { s.goodUser({ UniqueID: 501, PrimaryGroupID: 501 }); s.goodGroup({ PrimaryGroupID: 501 }); }, /outside the system range/);
  refusedAccount("UID 0", (s) => { s.goodUser({ UniqueID: 0, PrimaryGroupID: 0 }); s.goodGroup({ PrimaryGroupID: 0 }); }, /outside the system range/);
  refusedAccount("a UID shared with another account", (s) => { s.goodUser(); s.goodGroup(); s.acct("Users", "other", { UniqueID: 301 }); }, /UID 301 is used by more than one account/);
  refusedAccount("a GID shared with another group", (s) => { s.goodUser(); s.goodGroup(); s.acct("Groups", "other", { PrimaryGroupID: 301 }); }, /GID 301 is used by more than one group/);
  refusedAccount("a primary group that is not the UID", (s) => { s.goodUser({ PrimaryGroupID: 302 }); s.goodGroup({ PrimaryGroupID: 302 }); }, /primary group 302/);
  refusedAccount("a group whose id differs from the account's primary group", (s) => { s.goodUser(); s.goodGroup({ PrimaryGroupID: 302 }); }, /primary group 301 but group _praxisapproval is 302/);
  refusedAccount("a group id outside the system range", (s) => s.goodGroup({ PrimaryGroupID: 900 }), /outside the system range/);
  test("a complete, correct account (and an interrupted one) is accepted", () => {
    for (const prepare of [(s) => { s.goodUser(); s.goodGroup(); }, (s) => s.goodGroup(), (s) => s.goodUser({ UserShell: "", NFSHomeDirectory: "", IsHidden: "", Password: "" })]) {
      const s = sandbox();
      try {
        prepare(s);
        const r = s.pre();
        assert.equal(r.status, 0, r.stderr);
      } finally {
        s.cleanup();
      }
    }
  });
});

describe("dget parses every real dscl output format", darwin, () => {
  const lib = join(here, "macos-lib.sh");
  const get = (output, key) => {
    const dir = mkdtempSync("/tmp/pas-dget-");
    writeFileSync(join(dir, "out"), output);
    const r = spawnSync("/bin/sh", ["-c", `. "${lib}"; dscl() { cat "${dir}/out"; }; dget /Users/x ${key}`], { encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  test("standard, native and prefixed names, multi-line values, missing keys", () => {
    assert.equal(get("UniqueID: 206\n", "UniqueID"), "206");
    assert.equal(get("dsAttrTypeNative:IsHidden: 1\n", "IsHidden"), "1", "the case from the first real installation");
    assert.equal(get("dsAttrTypeStandard:UniqueID: 206\n", "UniqueID"), "206");
    assert.equal(get("dsAttrTypeStandard:UserShell: /usr/bin/false\n", "UserShell"), "/usr/bin/false");
    assert.equal(get("NFSHomeDirectory: /var/empty\n", "NFSHomeDirectory"), "/var/empty");
    assert.equal(get("Password: *\n", "Password"), "*");
    assert.equal(get("RealName:\n Praxis Approval Service\n", "RealName"), "Praxis Approval Service");
    assert.equal(get("RealName: Praxis Approval Service\n", "RealName"), "Praxis Approval Service");
    assert.equal(get("dsAttrTypeStandard:RealName:\n Praxis Approval Service\n", "RealName"), "Praxis Approval Service");
    assert.equal(get("dsAttrTypeNative:GroupMembership: a b\n", "GroupMembership"), "a b");
    assert.equal(get("GroupMembership: _praxisapproval mallory\n", "GroupMembership"), "_praxisapproval mallory");
    assert.equal(get("AuthenticationAuthority:\n ;ShadowHash;HASHLIST:<SALTED-SHA512-PBKDF2>\n ;Kerberosv5;\n", "AuthenticationAuthority"), ";ShadowHash;HASHLIST:<SALTED-SHA512-PBKDF2> ;Kerberosv5;");
    assert.equal(get("No such key: IsHidden\n", "IsHidden"), "");
    assert.equal(get("", "IsHidden"), "");
  });
  test("the checks are not weakened: wrong or present-but-bad values are still refused in the real formats", () => {
    for (const [attr, bad, expect] of [["IsHidden", 0, /not hidden/], ["UserShell", "/bin/zsh", /login shell/], ["NFSHomeDirectory", "/Users/x", /home directory/], ["Password", "x", /password/], ["AuthenticationAuthority", ";ShadowHash;", /authentication authority/]]) {
      const s = sandbox();
      try {
        s.goodUser({ [attr]: bad });
        s.goodGroup();
        const r = s.pre();
        assert.notEqual(r.status, 0, attr);
        assert.match(r.stderr, expect, attr);
      } finally {
        s.cleanup();
      }
    }
  });
  test("resuming after the first real failure: account complete (IsHidden in the native format), payload extracted, daemon not registered -> completes and registers, creating nothing again", () => {
    const s = sandbox();
    try {
      seedCode(s);
      s.goodUser({ UniqueID: 206, PrimaryGroupID: 206 });
      s.goodGroup({ PrimaryGroupID: 206 });
      mkdirSync(join(s.base, "state"));
      chmodSync(join(s.base, "state"), 0o700);
      s.owner(join(s.base, "state"), "_praxisapproval");
      const before = s.pre();
      assert.equal(before.status, 0, "the interrupted state is accepted by preinstall: " + before.stderr);
      const r = s.post();
      assert.equal(r.status, 0, r.stderr);
      const calls = s.calls();
      assert.ok(!calls.some((c) => /^dscl \. -create/.test(c) || c.startsWith("dseditgroup")), "an existing complete account is not touched");
      assert.ok(calls.some((c) => c.startsWith("launchctl bootstrap")), "the daemon is registered");
      assert.equal(readFileSync(join(s.sb, "db/Users/_praxisapproval/UniqueID"), "utf8"), "206", "the id stays");
    } finally {
      s.cleanup();
    }
  });
});

describe("preinstall: backups, downgrades", darwin, () => {
  test("a fresh install makes no backup; an upgrade backs up code, state, config, secrets and anchors root-only; a failed backup stops it", () => {
    const fresh = sandbox();
    try {
      assert.equal(fresh.pre().status, 0);
      assert.ok(!existsSync(join(fresh.base, "backups")));
    } finally {
      fresh.cleanup();
    }
    const s = sandbox({ version: "9.9.9" });
    try {
      seedCode(s, "9.9.8");
      mkdirSync(join(s.base, "state/trusted"), { recursive: true });
      writeFileSync(join(s.base, "state/trusted/private.pem"), "SECRET-KEY\n");
      mkdirSync(join(s.base, "secrets"));
      writeFileSync(join(s.base, "secrets/github.token"), "tok\n");
      mkdirSync(join(s.base, "anchors"));
      writeFileSync(join(s.base, "anchors/latest.json"), "{}");
      writeFileSync(join(s.base, "config.json"), '{"mode":"production"}\n');
      const r = s.pre();
      assert.equal(r.status, 0, r.stderr);
      const backups = join(s.base, "backups");
      assert.equal(s.mode(backups), "700");
      const [stamp] = readdirSync(backups);
      const dir = join(backups, stamp);
      assert.equal(s.mode(dir), "700");
      assert.equal(s.mode(join(dir, "state-and-config.tgz")), "600");
      assert.equal(readFileSync(join(dir, "version"), "utf8").trim(), "9.9.8");
      const listing = execFileSync("/usr/bin/tar", ["-tzf", join(dir, "state-and-config.tgz")], { encoding: "utf8" });
      for (const must of ["state/trusted/private\\.pem", "secrets/github\\.token", "anchors/latest\\.json", "config\\.json"]) assert.match(listing, new RegExp(must));
      const failing = s.pre({ SHIM_TAR_FAILS: "1" });
      assert.notEqual(failing.status, 0);
      assert.ok(existsSync(join(s.base, "state/trusted/private.pem")));
    } finally {
      s.cleanup();
    }
  });

  test("a downgrade is refused unless the owner creates allow-downgrade; backups are never deleted automatically", () => {
    const s = sandbox({ version: "1.0.0" });
    try {
      seedCode(s, "2.0.0");
      mkdirSync(join(s.base, "state"), { recursive: true });
      const refusedDowngrade = s.pre();
      assert.notEqual(refusedDowngrade.status, 0);
      assert.match(refusedDowngrade.stderr, /newer than 1\.0\.0/);
      writeFileSync(join(s.base, "allow-downgrade"), "");
      const backups = join(s.base, "backups");
      mkdirSync(backups, { recursive: true });
      for (let i = 1; i <= 8; i += 1) mkdirSync(join(backups, `2026010${i}000000`));
      const r = s.pre();
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readdirSync(backups).length, 9, "nothing was deleted");
      assert.match(r.stderr, /backups are kept/);
    } finally {
      s.cleanup();
    }
  });
});

describe("preinstall: version comparison understands pre-releases", darwin, () => {
  for (const [installed, pkg, ok] of [["0.1.0", "0.1.0-alpha.47", false], ["0.1.0-alpha.47", "0.1.0", true], ["0.1.0-alpha.9", "0.1.0-alpha.47", true], ["0.1.0-alpha.47", "0.1.0-alpha.9", false], ["0.2.0", "0.10.0", true], ["0.10.0", "0.2.0", false], ["1.0.0", "1.0.0", true]]) {
    test(`installed ${installed}, package ${pkg}: ${ok ? "accepted" : "refused as a downgrade"}`, () => {
      const s = sandbox({ version: pkg });
      try {
        seedCode(s, installed);
        mkdirSync(join(s.base, "state"), { recursive: true });
        chmodSync(join(s.base, "state"), 0o700);
        const r = s.pre();
        assert.equal(r.status === 0, ok, r.stderr);
        if (!ok) assert.match(r.stderr, /is newer than/);
      } finally {
        s.cleanup();
      }
    });
  }
});

describe("postinstall", darwin, () => {
  const ready = (s) => seedCode(s);

  test("creates the isolated account and the directories with exactly the intended owners and modes, then starts the daemon", () => {
    const s = sandbox();
    try {
      ready(s);
      const r = s.post();
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const calls = s.calls().join("\n");
      assert.match(calls, /dseditgroup -o create -r Praxis Approval Service -i 200 _praxisapproval/);
      for (const attribute of ["RealName Praxis Approval Service", "UserShell /usr/bin/false", "NFSHomeDirectory /var/empty", "Password *", "IsHidden 1", "UniqueID 200", "PrimaryGroupID 200"]) {
        assert.ok(calls.includes(`dscl . -create /Users/_praxisapproval ${attribute}`), attribute);
      }
      assert.match(calls, /install -d -o _praxisapproval -g _praxisapproval -m 0700 .*\/state/);
      assert.match(calls, /install -d -o _praxisapproval -g _praxisapproval -m 0700 .*\/secrets/);
      assert.match(calls, /install -d -o _praxisapproval -g _praxisapproval -m 0700 .*\/anchors/);
      for (const [path, mode] of [[join(s.base, "state"), "700"], [join(s.base, "run"), "755"], [join(s.base, "secrets"), "700"], [join(s.base, "anchors"), "700"], [s.log, "750"], [join(s.base, "backups"), "700"]]) assert.equal(s.mode(path), mode, path);
      const config = JSON.parse(readFileSync(join(s.base, "config.json"), "utf8"));
      assert.deepEqual(config, { mode: "production", principal: "_praxisapproval", repositories: [], operator: { port: 8780, origin: "http://localhost:8780" }, auditAnchorDirs: [join(s.base, "anchors")] });
      assert.equal(s.mode(join(s.base, "config.json")), "644");
      assert.ok(!/token|secret|password|key/i.test(readFileSync(join(s.base, "config.json"), "utf8").replace("auditAnchorDirs", "")), "the default configuration holds no secret and no secret-shaped key");
      assert.match(calls, /launchctl bootstrap system .*co\.praxis\.approval-service\.plist/);
      assert.ok(calls.indexOf("launchctl bootout") < calls.indexOf("launchctl bootstrap"), "an existing instance is stopped first");
    } finally {
      s.cleanup();
    }
  });

  test("refuses, without starting the daemon or creating an account, when the payload is not exactly what was built", () => {
    for (const [label, tamper, expect] of [
      ["a planted extra file", (s) => writeFileSync(join(s.base, "code/evil.sh"), "x"), /unexpected entry\(ies\) in the code directory: evil\.sh/],
      ["a planted empty directory", (s) => mkdirSync(join(s.base, "code/empty")), /unexpected entry\(ies\) in the code directory: empty/],
      ["a planted named pipe", (s) => execFileSync("mkfifo", [join(s.base, "code/pipe")]), /not a plain file or directory/],
      ["a file owned by an ordinary user", (s) => s.owner(join(s.base, "code/praxis-approval-service.mjs"), "501"), /not owned by root/],
      ["a missing file", (s) => rmSync(join(s.base, "code/ctl.sh")), /ctl\.sh is missing from the payload/],
      ["a symbolic link in the code", (s) => symlinkSync("/etc/passwd", join(s.base, "code/link")), /symbolic link/],
      ["a world-writable file", (s) => chmodSync(join(s.base, "code/praxis-approval-service.mjs"), 0o666), /writable by group/],
      ["a write ACL inside the code", (s) => addAcl(join(s.base, "code/node")), /ACL that grants write access/],
      ["a group-writable ancestor", (s) => chmodSync(join(s.sb, "Library/Application Support/Praxis"), 0o775), /writable by group or others/],
      ["an ancestor owned by a user", (s) => s.owner(join(s.sb, "Library/Application Support"), "501"), /not owned by root/],
      ["the code directory is a link", (s) => { const away = join(s.sb, "away"); cpSync(join(s.base, "code"), away, { recursive: true }); rmSync(join(s.base, "code"), { recursive: true }); symlinkSync(away, join(s.base, "code")); }, /symbolic link/],
      ["the plist destination became a symbolic link", (s) => { rmSync(s.plist); symlinkSync(join(s.sb, "nowhere"), s.plist); }, /dangling symbolic link/],
    ]) {
      const s = sandbox();
      try {
        ready(s);
        tamper(s);
        const r = s.post();
        assert.notEqual(r.status, 0, label);
        assert.match(r.stderr, expect, label);
        assert.ok(!s.calls().some((c) => c.startsWith("launchctl bootstrap")), `${label}: the daemon must not be started`);
        assert.ok(!s.calls().some((c) => /^(dscl \. -create|dseditgroup)/.test(c)), `${label}: no account is created before the code location is proven safe`);
      } finally {
        s.cleanup();
      }
    }
  });

  test("an existing configuration is kept byte for byte; ids come from a pair that is free in both directories", () => {
    const s = sandbox();
    try {
      ready(s);
      writeFileSync(join(s.base, "config.json"), '{"mode":"production","repositories":[{"path":"/r","branches":["main"]}]}\n', { mode: 0o600 });
      const before = readFileSync(join(s.base, "config.json"), "utf8");
      s.acct("Users", "alice", { UniqueID: 200 });
      s.acct("Users", "bob", { UniqueID: 201 });
      s.acct("Groups", "staff", { PrimaryGroupID: 202 });
      s.acct("Groups", "team", { PrimaryGroupID: 203 });
      s.acct("Users", "carol", { UniqueID: 204 });
      const r = s.post();
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(s.base, "config.json"), "utf8"), before);
      assert.equal(s.mode(join(s.base, "config.json")), "644", "root-owned and readable; it holds no secret");
      assert.match(s.calls().join("\n"), /UniqueID 205/);
    } finally {
      s.cleanup();
    }
  });

  test("an interrupted installation is completed: group only, user only, attributes missing; a second run changes nothing", () => {
    for (const [label, prepare] of [
      ["group only", (s) => s.goodGroup({ PrimaryGroupID: 310 })],
      ["user only, nothing else set", (s) => s.acct("Users", "_praxisapproval", { RealName: "Praxis Approval Service", UniqueID: 311, PrimaryGroupID: 311 })],
      ["user and group, attributes missing", (s) => { s.acct("Users", "_praxisapproval", { RealName: "Praxis Approval Service", UniqueID: 312, PrimaryGroupID: 312 }); s.goodGroup({ PrimaryGroupID: 312 }); }],
    ]) {
      const s = sandbox();
      try {
        ready(s);
        prepare(s);
        const r = s.post();
        assert.equal(r.status, 0, `${label}: ${r.stderr}`);
        const calls = s.calls().join("\n");
        assert.match(calls, /UserShell \/usr\/bin\/false/, label);
        assert.match(calls, /IsHidden 1/, label);
        assert.match(calls, /Password \*/, label);
        const id = readFileSync(join(s.sb, "db/Users/_praxisapproval/UniqueID"), "utf8");
        assert.ok(["310", "311", "312"].includes(id), `${label}: the id of what already existed is kept, got ${id}`);
        assert.equal(readFileSync(join(s.sb, "db/Groups/_praxisapproval/PrimaryGroupID"), "utf8"), id, label);
        const created = s.calls().filter((c) => /^dscl \. -create \/Users\/_praxisapproval \S+ /.test(c)).length;
        const again = s.post();
        assert.equal(again.status, 0, `${label}: second run ${again.stderr}`);
        assert.equal(s.calls().filter((c) => /^dscl \. -create \/Users\/_praxisapproval \S+ /.test(c)).length, created, `${label}: a second run sets nothing again`);
      } finally {
        s.cleanup();
      }
    }
  });

  test("refuses an existing account whose attributes conflict, without starting the daemon", () => {
    const s = sandbox();
    try {
      ready(s);
      s.goodUser({ UserShell: "/bin/bash" });
      s.goodGroup();
      const r = s.post();
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /login shell '\/bin\/bash'/);
      assert.ok(!s.calls().some((c) => c.startsWith("launchctl bootstrap")));
    } finally {
      s.cleanup();
    }
  });

  test("does not start the daemon when a directory it relies on is owned by someone else", () => {
    const s = sandbox();
    try {
      ready(s);
      mkdirSync(join(s.base, "state"));
      s.goodUser();
      s.goodGroup();
      s.owner(join(s.base, "state"), "501");
      const r = s.post();
      assert.notEqual(r.status, 0);
      assert.ok(!s.calls().some((c) => c.startsWith("launchctl bootstrap")));
    } finally {
      s.cleanup();
    }
  });
});

describe("ctl.sh: health, verify, backup, rollback, restore-state, uninstall (sandboxed)", darwin, () => {
  const withNode = (s, healthJson) => {
    const code = seedCode(s);
    writeFileSync(join(code, "node/bin/node"), `#!/bin/sh\ncat <<'JSON'\n${healthJson}\nJSON\n`, { mode: 0o755 });
    return code;
  };
  const health = (over = {}) => JSON.stringify({ ok: true, health: { mode: "production", isolation: { verified: true }, integrity: { ok: true }, ...over } }, null, 2);
  const installed = (s) => {
    seedCode(s);
    for (const d of ["state/ledger", "state/audit", "state/trusted", "secrets", "anchors", "run", "backups"]) mkdirSync(join(s.base, d), { recursive: true });
    writeFileSync(join(s.base, "state/ledger/c-1.json"), '{"status":"completed"}');
    writeFileSync(join(s.base, "state/audit/chain.jsonl"), "{}\n", { mode: 0o600 });
    writeFileSync(join(s.base, "state/trusted/private.pem"), "KEY\n", { mode: 0o600 });
    writeFileSync(join(s.base, "anchors/latest.json"), "{}", { mode: 0o600 });
    writeFileSync(join(s.base, "config.json"), "{}\n", { mode: 0o644 });
    for (const d of ["state", "secrets", "anchors"]) chmodSync(join(s.base, d), 0o700);
    s.goodUser();
    s.goodGroup();
  };

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

  test("verify reports the owner, mode and ACL of everything created, and fails on a wrong mode, an ACL, a link or a readable key", () => {
    const s = sandbox();
    try {
      installed(s);
      mkdirSync(s.log, { recursive: true });
      for (const path of ["state", "secrets", "anchors", "run", "state/ledger", "state/audit", "state/trusted", "state/trusted/private.pem", "state/audit/chain.jsonl"]) s.owner(join(s.base, path), "_praxisapproval");
      s.owner(s.log, "_praxisapproval");
      for (const [path, mode] of [["state", 0o700], ["secrets", 0o700], ["anchors", 0o700], ["run", 0o755], ["state/ledger", 0o700], ["state/audit", 0o700], ["state/trusted", 0o700], ["backups", 0o700], ["code", 0o755]]) chmodSync(join(s.base, path), mode);
      chmodSync(s.log, 0o750);
      const ok = s.run("ctl", ["verify"]);
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.match(ok.stdout, /PASS .*state {2}_praxisapproval 700/);
      assert.match(ok.stdout, /verified/);
      for (const [label, tamper, expect] of [
        ["world-readable state", () => chmodSync(join(s.base, "state"), 0o755), /FAIL .*state {2}is _praxisapproval 755/],
        ["readable signing key", () => { chmodSync(join(s.base, "state"), 0o700); chmodSync(join(s.base, "state/trusted/private.pem"), 0o644); }, /FAIL .*private\.pem/],
        ["ACL on the ledger", () => { chmodSync(join(s.base, "state/trusted/private.pem"), 0o600); addAcl(join(s.base, "state/ledger")); }, /FAIL .*ledger .*ACL entry/],
        ["a link in the code tree", () => { execFileSync("chmod", ["-N", join(s.base, "state/ledger")]); symlinkSync("/etc/hosts", join(s.base, "code/x")); }, /symbolic link inside the code directory/],
      ]) {
        tamper();
        const r = s.run("ctl", ["verify"]);
        assert.notEqual(r.status, 0, label);
        assert.match(r.stdout + r.stderr, expect, label);
      }
    } finally {
      s.cleanup();
    }
  });

  test("every management command except health and verify refuses to run unless root", () => {
    const s = sandbox();
    try {
      installed(s);
      for (const args of [["backup"], ["rollback"], ["restore-state", "20200101000000"], ["uninstall"]]) {
        const r = s.run("ctl", args, { SHIM_UID: "501" });
        assert.notEqual(r.status, 0, args.join(" "));
        assert.match(r.stderr, /run as root/);
      }
    } finally {
      s.cleanup();
    }
  });

  test("ROLLBACK after an approval was used: only the code goes back; ledger, audit, anchors and keys are untouched, so the approval stays used", () => {
    const s = sandbox();
    try {
      const code = seedCode(s, "1.0.0");
      installed(s);
      writeFileSync(join(code, "MANIFEST.json"), JSON.stringify({ version: "1.0.0" }));
      assert.equal(s.run("ctl", ["backup"]).status, 0);
      writeFileSync(join(code, "MANIFEST.json"), JSON.stringify({ version: "2.0.0" }));
      writeFileSync(join(s.base, "state/ledger/c-2.json"), '{"status":"completed","result":{"commit":"abc"}}');
      writeFileSync(join(s.base, "state/audit/chain.jsonl"), "{}\n{}\n");
      writeFileSync(join(s.base, "anchors/latest.json"), '{"seq":2}');
      const before = { ledger: readdirSync(join(s.base, "state/ledger")).sort(), audit: readFileSync(join(s.base, "state/audit/chain.jsonl"), "utf8"), anchor: readFileSync(join(s.base, "anchors/latest.json"), "utf8"), key: readFileSync(join(s.base, "state/trusted/private.pem"), "utf8") };
      const r = s.run("ctl", ["rollback"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(readFileSync(join(code, "MANIFEST.json"), "utf8"), /1\.0\.0/, "the code is the previous version");
      assert.deepEqual(readdirSync(join(s.base, "state/ledger")).sort(), before.ledger, "the used approval is still recorded as used");
      assert.equal(readFileSync(join(s.base, "state/audit/chain.jsonl"), "utf8"), before.audit);
      assert.equal(readFileSync(join(s.base, "anchors/latest.json"), "utf8"), before.anchor);
      assert.equal(readFileSync(join(s.base, "state/trusted/private.pem"), "utf8"), before.key);
      assert.match(r.stdout, /approvals already used stay used/);
      const old = s.run("ctl", ["rollback", "--restore-state"]);
      assert.equal(old.status, 0, "an unknown trailing argument must not restore state");
      assert.deepEqual(readdirSync(join(s.base, "state/ledger")).sort(), before.ledger);
      const empty = sandbox();
      try {
        installed(empty);
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

  test("rollback refuses a backup whose code was tampered with (link, writable file, ACL)", () => {
    for (const tamper of [(d) => symlinkSync("/etc/passwd", join(d, "code/x")), (d) => chmodSync(join(d, "code/praxis-approval-service.mjs"), 0o666), (d) => addAcl(join(d, "code/ctl.sh"))]) {
      const s = sandbox();
      try {
        installed(s);
        assert.equal(s.run("ctl", ["backup"]).status, 0);
        const [stamp] = readdirSync(join(s.base, "backups"));
        tamper(join(s.base, "backups", stamp));
        const r = s.run("ctl", ["rollback"]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /symbolic link|writable by group|ACL/);
        assert.ok(existsSync(join(s.base, "code/praxis-approval-service.mjs")), "the live code was not removed");
      } finally {
        s.cleanup();
      }
    }
  });

  test("restore-state is gated: bad names, links, a running service, recent activity in the CURRENT state; an old backup is restored (anchors left alone) after the current state is saved", () => {
    const s = sandbox();
    try {
      installed(s);
      const backups = join(s.base, "backups");
      for (const name of ["../x", "2026", "abc", "20260101000000/../..", "", "1", "99999999999999999"]) {
        const r = s.run("ctl", ["restore-state", name]);
        assert.notEqual(r.status, 0, JSON.stringify(name));
        assert.match(r.stderr, /not a backup name|no such backup/);
      }
      mkdirSync(join(s.sb, "elsewhere"));
      symlinkSync(join(s.sb, "elsewhere"), join(backups, "20200101000000"));
      assert.match(s.run("ctl", ["restore-state", "20200101000000"]).stderr, /no such backup/);
      rmSync(join(backups, "20200101000000"));
      mkdirSync(join(backups, "20200101000000"));
      writeFileSync(join(s.base, "anchors/latest.json"), '{"seq":9}');
      execFileSync("/usr/bin/tar", ["-C", s.base, "-czf", join(backups, "20200101000000/state-and-config.tgz"), "state", "config.json", "secrets", "anchors"]);
      writeFileSync(join(s.base, "state/ledger/c-NEW.json"), '{"status":"completed"}');
      writeFileSync(join(s.base, "anchors/latest.json"), '{"seq":42}');
      // the OLD backup is no reason by itself: what counts is that the CURRENT state was just used
      const recent = s.run("ctl", ["restore-state", "20200101000000"]);
      assert.notEqual(recent.status, 0);
      assert.match(recent.stderr, /changed less than 25 hours ago/);
      assert.ok(existsSync(join(s.base, "state/ledger/c-NEW.json")), "nothing was changed");
      execFileSync("find", [join(s.base, "state"), join(s.base, "secrets"), join(s.base, "anchors"), "-exec", "touch", "-t", "202001010000", "{}", "+"]);
      const running = s.run("ctl", ["restore-state", "20200101000000"], { SHIM_SERVICE_RUNNING: "1" });
      assert.notEqual(running.status, 0);
      assert.match(running.stderr, /stop the service first/);
      for (const [label, mutate, expect] of [
        ["an archive with a link", (tgz) => { const w = mkdtempSync(join(s.sb, "w-")); execFileSync("/usr/bin/tar", ["-xzf", tgz, "-C", w]); symlinkSync("/etc/passwd", join(w, "state/evil")); execFileSync("/usr/bin/tar", ["-C", w, "-czf", tgz, "state", "config.json", "secrets", "anchors"]); }, /links, devices or pipes/],
        ["an archive with an unexpected top-level name", (tgz) => { const w = mkdtempSync(join(s.sb, "w-")); execFileSync("/usr/bin/tar", ["-xzf", tgz, "-C", w]); writeFileSync(join(w, "stray"), "x"); execFileSync("/usr/bin/tar", ["-C", w, "-czf", tgz, "state", "config.json", "secrets", "anchors", "stray"]); }, /unexpected paths/],
      ]) {
        const copy = join(backups, "20200202000000");
        mkdirSync(copy);
        cpSync(join(backups, "20200101000000/state-and-config.tgz"), join(copy, "state-and-config.tgz"));
        mutate(join(copy, "state-and-config.tgz"));
        const r = s.run("ctl", ["restore-state", "20200202000000"]);
        assert.notEqual(r.status, 0, label);
        assert.match(r.stderr, expect, label);
        assert.ok(existsSync(join(s.base, "state/ledger/c-NEW.json")), `${label}: nothing was changed`);
        rmSync(copy, { recursive: true });
      }
      const r = s.run("ctl", ["restore-state", "20200101000000"]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(join(s.base, "state/ledger/c-NEW.json")), "the old state is back");
      assert.equal(readFileSync(join(s.base, "anchors/latest.json"), "utf8"), '{"seq":42}', "the independent anchors are NOT rolled back");
      const saved = readdirSync(backups).find((f) => f.endsWith("-before-restore"));
      assert.ok(saved, "the state that was replaced is saved first");
      const listing = execFileSync("/usr/bin/tar", ["-tzf", join(backups, saved, "state-and-config.tgz")], { encoding: "utf8" });
      assert.match(listing, /c-NEW\.json/);
      assert.match(r.stdout, /previous state is saved/);
      assert.match(r.stdout, /anchors left as they are/);
      assert.ok(!readdirSync(s.base).some((f) => f.startsWith(".restore.")), "no scratch directory left behind");
    } finally {
      s.cleanup();
    }
  });

  test("backup refuses a running service (a torn snapshot) unless --live is given; rollback skips a '-before-restore' folder and swaps the code in one step", () => {
    const s = sandbox();
    try {
      installed(s);
      const running = s.run("ctl", ["backup"], { SHIM_SERVICE_RUNNING: "1" });
      assert.notEqual(running.status, 0);
      assert.match(running.stderr, /the service is running: stop it first/);
      assert.equal(readdirSync(join(s.base, "backups")).length, 0);
      writeFileSync(join(s.base, "code/MANIFEST.json"), '{"version":"1.0.0"}');
      assert.equal(s.run("ctl", ["backup", "--live"], { SHIM_SERVICE_RUNNING: "1" }).status, 0);
      const [good] = readdirSync(join(s.base, "backups"));
      mkdirSync(join(s.base, "backups", "99999999999999-before-restore"));
      writeFileSync(join(s.base, "code/MANIFEST.json"), '{"version":"9.9.9"}');
      const r = s.run("ctl", ["rollback"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`backup ${good}`));
      assert.ok(!existsSync(join(s.base, ".code.new")) && !existsSync(join(s.base, ".code.old")), "no scratch directories left");
      assert.ok(!/9\.9\.9/.test(readFileSync(join(s.base, "code/MANIFEST.json"), "utf8")), "the backup's code is back");
    } finally {
      s.cleanup();
    }
  });

  test("UNINSTALL keeps all protected data; --remove-data removes live data only after a recovery archive; --delete-everything needs the exact phrase", () => {
    const run = (args, env, check) => {
      const s = sandbox();
      try {
        installed(s);
        mkdirSync(s.log, { recursive: true });
        check(s, s.run("ctl", args, env));
      } finally {
        s.cleanup();
      }
    };
    run(["uninstall"], {}, (s, r) => {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(join(s.base, "code")) && !existsSync(s.plist), "daemon and code are gone");
      for (const keep of ["state/ledger/c-1.json", "state/trusted/private.pem", "config.json", "secrets", "anchors/latest.json"]) assert.ok(existsSync(join(s.base, keep)), `${keep} must be kept`);
      assert.equal(readdirSync(join(s.base, "backups")).length, 1, "a backup is taken first");
      assert.ok(!s.calls().some((c) => c.startsWith("dscl . -delete")), "the account stays");
      assert.match(r.stdout, /State, configuration, secrets, anchors, backups and the service account remain/);
    });
    run(["uninstall", "--remove-data"], {}, (s, r) => {
      assert.equal(r.status, 0, r.stderr);
      for (const gone of ["state", "config.json", "secrets", "anchors", "code"]) assert.ok(!existsSync(join(s.base, gone)), `${gone} must be removed`);
      const [archive] = readdirSync(join(s.base, "backups"));
      const listing = execFileSync("/usr/bin/tar", ["-tzf", join(s.base, "backups", archive, "state-and-config.tgz")], { encoding: "utf8" });
      assert.match(listing, /state\/ledger\/c-1\.json/);
      assert.match(listing, /secrets/);
      assert.match(listing, /anchors\/latest\.json/);
      assert.match(s.calls().join("\n"), /dscl \. -delete \/Users\/_praxisapproval/);
      assert.match(r.stdout, /recovery archive/);
    });
    run(["uninstall", "--delete-everything"], {}, (s, r) => {
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /praxis-delete-all-data/);
      assert.ok(existsSync(join(s.base, "state")) && existsSync(join(s.base, "code")), "nothing was removed without the phrase");
      assert.equal(readdirSync(join(s.base, "backups")).length, 0, "not even a backup was started");
    });
    run(["uninstall", "--delete-everything", "yes"], {}, (s, r) => {
      assert.notEqual(r.status, 0);
      assert.ok(existsSync(join(s.base, "state")));
    });
    run(["uninstall", "--delete-everything", "praxis-delete-all-data"], {}, (s, r) => {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(join(s.base, "backups")) && !existsSync(join(s.base, "state")));
      assert.match(r.stdout, /Deleted the backups as well/);
    });
    run(["uninstall", "--purge"], {}, (s, r) => {
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /--purge no longer exists/);
      assert.ok(existsSync(join(s.base, "state")) && existsSync(join(s.base, "code")));
    });
    for (const args of [["uninstall"], ["uninstall", "--remove-data"], ["uninstall", "--delete-everything", "praxis-delete-all-data"]]) {
      run(args, { SHIM_TAR_FAILS: "1" }, (s, r) => {
        assert.notEqual(r.status, 0, args.join(" "));
        assert.ok(existsSync(join(s.base, "state/ledger/c-1.json")) && existsSync(join(s.base, "code")), `${args.join(" ")}: a failed backup stops everything`);
      });
    }
  });
});


describe("the built package and its launchd configuration (unprivileged inspection)", { skip: process.platform !== "darwin" }, () => {
  
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
    assert.ok(json.StandardOutPath.startsWith("/private/var/log/praxis-approval/"));
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
