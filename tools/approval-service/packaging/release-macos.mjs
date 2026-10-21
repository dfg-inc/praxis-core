#!/usr/bin/env node
/**
 * Assembles the macOS release folder for the OWNER: the Approval Service package, the Desktop Runtime extension, the build
 * manifest, checksums, instructions and the acceptance kit, after checking that the two products are compatible.
 * Unprivileged; copies and hashes only. Role plug-in ZIPs are not rebuilt or copied: they are listed with their hashes.
 *
 *   node tools/approval-service/packaging/release-macos.mjs [--mcpb <file>] [--roles <dir>] [--out <dir>]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = resolve(here, "../../..");
const split = resolve(core, "..");
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const fail = (m) => {
  console.error(`release-macos: ${m}`);
  process.exit(1);
};

const pkgDir = join(core, "dist/approval-service/production");
const manifest = JSON.parse(readFileSync(join(pkgDir, "MANIFEST.json"), "utf8"));
const pkgName = Object.keys(manifest.components).find((n) => n.endsWith(".pkg"));
if (!pkgName) fail("no .pkg in the build manifest; run build.mjs --macos-pkg first");
if (!manifest.nodeRuntime?.bundled) fail("the package has no bundled Node runtime; it cannot start. Build with --node-tarball/--node-shasums");
const pkgPath = join(pkgDir, pkgName);
if (sha(pkgPath) !== manifest.components[pkgName].sha256) fail("the package on disk does not match the build manifest (rebuild)");
const mcpb = resolve(flag("--mcpb", join(split, "praxis-runtime/claude-extensions/praxis-runtime.mcpb")));
const roles = resolve(flag("--roles", join(split, "desktop-install")));
if (!existsSync(mcpb)) fail(`Desktop extension not found at ${mcpb}`);
const out = resolve(flag("--out", join(split, "release", `macos-approval-service-${manifest.version}`)));

// --- compatibility between the service package and the Desktop Runtime extension --------------------------------------
const tmp = mkdtempSync("/tmp/pas-rel-");
execFileSync("unzip", ["-q", mcpb, "-d", tmp]);
const bundle = readFileSync(join(tmp, "server/praxis-mcp.cjs"), "utf8");
const mcpbManifest = JSON.parse(readFileSync(join(tmp, "manifest.json"), "utf8"));
const infoMatch = /"coreBaseline":"([0-9a-f]{40})"/.exec(bundle);
const coreBaseline = infoMatch?.[1];
const git = (...a) => execFileSync("git", ["-C", core, ...a], { encoding: "utf8" }).trim();
const coreHead = git("rev-parse", "HEAD");
const runtimeChanged = coreBaseline ? git("diff", "--name-only", `${coreBaseline}..HEAD`, "--", "packages", "plugins").split("\n").filter(Boolean) : ["(unknown baseline)"];
const checks = {
  protocolInService: manifest.protocol,
  protocolInExtension: bundle.includes(manifest.protocol) ? manifest.protocol : null,
  extensionVersion: mcpbManifest.version,
  serviceVersion: manifest.version,
  extensionCoreBaseline: coreBaseline ?? null,
  coreHead,
  runtimeSourcesChangedSinceExtensionBaseline: runtimeChanged,
};
const problems = [];
if (checks.protocolInExtension !== manifest.protocol) problems.push("the extension does not speak the service's protocol");
if (checks.extensionVersion !== manifest.version) problems.push(`versions differ: extension ${checks.extensionVersion}, service ${manifest.version}`);
if (runtimeChanged.length) problems.push(`Runtime sources changed since the extension was built: ${runtimeChanged.join(", ")} (rebuild the extension)`);
rmSync(tmp, { recursive: true, force: true });
if (problems.length) fail(`incompatible: ${problems.join("; ")}`);

// --- assemble -----------------------------------------------------------------------------------------------------------
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "acceptance"), { recursive: true });
copyFileSync(pkgPath, join(out, pkgName));
copyFileSync(mcpb, join(out, "praxis-runtime.mcpb"));
const build = { ...manifest, release: { assembledAt: new Date().toISOString(), coreCommit: coreHead, desktopExtension: { file: "praxis-runtime.mcpb", sha256: sha(mcpb), version: mcpbManifest.version, coreBaseline } } };
writeFileSync(join(out, "BUILD-MANIFEST.json"), `${JSON.stringify(build, null, 2)}\n`);
writeFileSync(join(out, "NODE-PROVENANCE.json"), `${JSON.stringify(manifest.nodeRuntime, null, 2)}\n`);
writeFileSync(join(out, "COMPATIBILITY.json"), `${JSON.stringify({ ok: true, ...checks }, null, 2)}\n`);
for (const f of ["MACOS-ACCEPTANCE.md", "SECURITY-REVIEW.md", "README.md", "ISOLATION-ACCEPTANCE.md"]) copyFileSync(join(core, "docs/approval-service", f), join(out, f));
cpSync(join(here, "../acceptance/macos"), join(out, "acceptance"), { recursive: true });

const P = `${out}/${pkgName}`;
const CTL = '"/Library/Application Support/Praxis/ApprovalService/code/ctl.sh"';
writeFileSync(join(out, "INSTALL-MACOS.md"), `# Installing the Praxis Approval Service on macOS (Apple Silicon)

Release folder: \`${out}\`
Package: \`${P}\`  
SHA-256: \`${sha(pkgPath)}\` (unsigned; macOS will warn)

Nothing below has been run for you. Each \`sudo\` command is yours to approve.

## 1. Verify (no sudo)
\`\`\`bash
cd "${out}" && shasum -a 256 -c SHA256SUMS
\`\`\`
\`\`\`bash
pkgutil --check-signature "${P}"
\`\`\`
Expected: every line OK; "no signature" for the package. The bundled Node is the official ${manifest.nodeRuntime.version} (arm64), signed by the
Node.js Foundation; its provenance is in NODE-PROVENANCE.json.

## 2. What the installer will do, and how to read it first
\`\`\`bash
pkgutil --expand-full "${P}" /tmp/praxis-pkg-inspect && less /tmp/praxis-pkg-inspect/Scripts/preinstall /tmp/praxis-pkg-inspect/Scripts/postinstall
\`\`\`
Before anything is extracted the preinstall refuses (changing nothing) if an existing ancestor or location of the installation is a symbolic
link (a dangling one included), is not owned by root, is group/other-writable or has a write-granting ACL entry, and if \`_praxisapproval\` already
exists but is not provably this installer's account (UID, GID, shell, home, hidden, password, group memberships). Then it creates (or completes)
the hidden role account \`_praxisapproval\` (no shell, no home, no password), the directories under
\`/Library/Application Support/Praxis/ApprovalService\` (state, secrets, anchors 0700; run 0755; backups root-only), \`/private/var/log/praxis-approval\`,
and the LaunchDaemon \`/Library/LaunchDaemons/co.praxis.approval-service.plist\`. The default \`config.json\` holds public settings only: credentials
live as files in \`secrets/\` and are only named in the configuration. After install run \`ctl.sh verify\`: every line must be PASS.

## 3. Install (administrator)
\`\`\`bash
sudo installer -pkg "${P}" -target /
\`\`\`
\`\`\`bash
sudo ${CTL} health
\`\`\`

## 4. Acceptance
Follow \`MACOS-ACCEPTANCE.md\` (steps A to J) with the scripts in \`acceptance/\`. Use only the throwaway test repository. The scripts use the
praxis-core checkout's built client library:
\`\`\`bash
export PRAXIS_CORE=/Users/serg/work/praxis-split/praxis-core
\`\`\`
\`\`\`bash
"${out}/acceptance/acceptance.sh" setup-repo
\`\`\`

## 5. Desktop extension
\`praxis-runtime.mcpb\` (sha256 ${sha(mcpb)}) is the Runtime that delegates to this service; on macOS no setting is needed (default socket
\`/Library/Application Support/Praxis/ApprovalService/run/service.sock\`). Install it in Claude Desktop yourself (Settings > Extensions) only
after the service passes acceptance; start a **new** chat afterwards (tool lists are fixed per session). Check with \`praxis_doctor\`:
\`approvalService.reachable: true\`, \`isolated: true\`. The role plug-in ZIPs are unchanged (see ROLE-ZIPS.txt).

## Roll back or remove (administrator)
\`\`\`bash
sudo ${CTL} backup
\`\`\`
\`\`\`bash
sudo ${CTL} rollback
\`\`\`
\`\`\`bash
sudo ${CTL} uninstall
\`\`\`
\`\`\`bash
sudo ${CTL} uninstall --remove-data
\`\`\`
\`uninstall\` keeps state, configuration, secrets, anchors, backups and the account. \`--remove-data\` also removes live data and the role account, but only after a recovery archive was written to backups. Deleting the backups too is a third, separate command (\`--delete-everything praxis-delete-all-data\`, see ROLLBACK-MACOS.md). Backups are root-only, in \`/Library/Application Support/Praxis/ApprovalService/backups\`. To remove the Desktop extension, uninstall it in Claude Desktop.
`);
writeFileSync(join(out, "ROLLBACK-MACOS.md"), `# Rollback and removal (administrator)

Backups are taken automatically before every upgrade and every uninstall, into a root-only folder, and are never deleted automatically.

\`\`\`bash
sudo ${CTL} backup
\`\`\`
\`\`\`bash
sudo ${CTL} rollback
\`\`\`
Puts the previous version's CODE back. State, ledger, audit chain, anchors and keys are not touched, so an approval that was already used stays used.
\`\`\`bash
sudo ${CTL} verify
\`\`\`
Reports owner, mode and ACL of everything the installation created (no root needed to read most of it). Any FAIL line means a permission is not as intended.
\`\`\`bash
sudo ${CTL} health
\`\`\`
\`\`\`bash
sudo ${CTL} restore-state <backup-name>
\`\`\`
Disaster recovery only. Puts an OLD state and secrets back: refused while the service runs and when anything in the current state changed in the last 25 hours; the archive is checked and the current state is saved first. The anchors are not restored. An older ledger makes consumed approvals look unused, so the service refuses to start while an anchor is newer than the restored state. That refusal is the protection working; do not weaken it.
\`\`\`bash
sudo ${CTL} uninstall
\`\`\`
Removes the daemon and the code. Keeps state, configuration, secrets, anchors, backups and the account.
\`\`\`bash
sudo ${CTL} uninstall --remove-data
\`\`\`
Also removes state, configuration, secrets, anchors and the account, after a recovery archive is written to backups (which stay). Verify: \`dscl . -read /Users/_praxisapproval\` must fail; \`ls /Library/LaunchDaemons | grep praxis\` must print nothing.
\`\`\`bash
sudo ${CTL} uninstall --delete-everything praxis-delete-all-data
\`\`\`
Also deletes the backups. Irreversible. Nothing deletes backups otherwise.
Desktop extension: uninstall it in Claude Desktop (Settings > Extensions); the previous extension file is in \`/Users/serg/work/praxis-split/desktop-install\` history only if you kept it.
`);
const roleZips = existsSync(roles) ? readdirSync(roles).filter((f) => /^praxis-.*\.zip$/.test(f)) : [];
writeFileSync(join(out, "ROLE-ZIPS.txt"), `Role plug-in ZIPs are NOT rebuilt or copied. Their current files and hashes:\n${roleZips.map((f) => `${sha(join(roles, f))}  ${join(roles, f)}`).join("\n")}\n`);
const listed = readdirSync(out).filter((f) => statSync(join(out, f)).isFile() && f !== "SHA256SUMS");
const acc = readdirSync(join(out, "acceptance")).map((f) => `acceptance/${f}`).filter((f) => statSync(join(out, f)).isFile());
writeFileSync(join(out, "SHA256SUMS"), [...listed, ...acc].sort().map((f) => `${sha(join(out, f))}  ${f}`).join("\n") + "\n");
console.log(JSON.stringify({ ok: true, out, package: P, packageSha256: sha(pkgPath), extensionSha256: sha(mcpb), nodeRuntime: manifest.nodeRuntime.version }, null, 2));
