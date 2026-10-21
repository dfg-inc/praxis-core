/**
 * macOS adapter: a launchd system daemon (/Library/LaunchDaemons) running as a dedicated role account.
 * An ordinary same-user LaunchAgent is NOT used and would not be isolated. Nothing here executes a privileged
 * command: installPlan() returns the steps for the owner to review, and the .pkg postinstall script performs the same
 * steps when the owner runs the installer.
 */
import { check, posixIsolationChecks } from "./common.mjs";

export const LABEL = "co.praxis.approval-service";
export const PRINCIPAL = "_praxisapproval";

export function defaults() {
  const base = "/Library/Application Support/Praxis/ApprovalService";
  return {
    id: "darwin",
    principal: PRINCIPAL,
    stateDir: `${base}/state`,
    configFile: `${base}/config.json`,
    endpoint: `${base}/run/service.sock`,
    codeDir: `${base}/code`,
    logDir: "/var/log/praxis-approval",
    unitFile: `/Library/LaunchDaemons/${LABEL}.plist`,
    baseDir: base,
  };
}

export function probe(ctx) {
  return posixIsolationChecks(ctx).concat(
    check("init-supervised", true, process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== "0" ? `launched by launchd as ${process.env.XPC_SERVICE_NAME} (informational)` : "not launched by launchd (informational: isolation does not depend on who started the process)"),
  );
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderUnit(paths = defaults()) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(paths.codeDir)}/node/bin/node</string>
    <string>${xml(paths.codeDir)}/praxis-approval-service.mjs</string>
    <string>run</string>
    <string>--config</string>
    <string>${xml(paths.configFile)}</string>
  </array>
  <key>UserName</key><string>${PRINCIPAL}</string>
  <key>GroupName</key><string>${PRINCIPAL}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>18</integer>
  <key>WorkingDirectory</key><string>${xml(paths.stateDir)}</string>
  <key>StandardOutPath</key><string>${xml(paths.logDir)}/service.log</string>
  <key>StandardErrorPath</key><string>${xml(paths.logDir)}/service.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PRAXIS_BUNDLE_KIND</key><string>production</string>
  </dict>
</dict>
</plist>
`;
}

/** Steps for the owner. `privileged: true` steps need an administrator; none is run by Praxis itself. */
export function installPlan(paths = defaults()) {
  return [
    { id: "build", privileged: false, description: "Build the package unprivileged (supply a self-contained official Node binary for this architecture)", command: "node tools/approval-service/packaging/build.mjs --variant production --macos-pkg --node /path/to/official/node" },
    { id: "verify", privileged: false, description: "Check the package against its manifest and signature state before installing", command: "shasum -a 256 <pkg>; pkgutil --check-signature <pkg>; pkgutil --payload-files <pkg>" },
    { id: "install", privileged: true, description: `The package's preinstall checks architecture, macOS version, link/ownership of ${paths.baseDir} and downgrades, and takes a root-only backup of any existing install; its postinstall creates the role account ${PRINCIPAL} (UID/GID free in 200-399, hidden, no shell, no home, no password), creates the directories (state 0700, run 0755, logs 0750), keeps an existing config.json, verifies every ancestor of the code directory is root-owned and not group/other-writable, and starts the daemon`, command: "sudo installer -pkg <pkg> -target /" },
    { id: "health", privileged: true, description: "Verify production mode, isolation and integrity", command: `sudo "${paths.codeDir}/ctl.sh" health` },
    { id: "allow-repo", privileged: true, description: "Per repository: grant the service an inheritable write ACL on .git and add the entry (path, exact remotes, branches) to config.json", command: "node tools/approval-service/praxis-approval-service.mjs allow-repo <path>" },
    { id: "enroll", privileged: true, description: "Open a 15 minute enrollment window as the service identity and enroll Touch ID or a security key", command: `sudo -u ${PRINCIPAL} "${paths.codeDir}/node/bin/node" "${paths.codeDir}/praxis-approval-service.mjs" enroll-code --config "${paths.configFile}"` },
  ];
}

export function uninstallPlan(paths = defaults()) {
  return [
    { id: "backup", privileged: true, description: "Root-only backup (state, configuration, code) under backups/, taken automatically by uninstall and by every upgrade", command: `sudo "${paths.codeDir}/ctl.sh" backup` },
    { id: "rollback", privileged: true, description: "Restore the previous code (add --restore-state to also restore state; see the warning it prints)", command: `sudo "${paths.codeDir}/ctl.sh" rollback` },
    { id: "uninstall", privileged: true, description: "Stop and remove the daemon and code; keep state, configuration and backups", command: `sudo "${paths.codeDir}/ctl.sh" uninstall` },
    { id: "purge", privileged: true, description: "Also remove state, configuration and the role account (a backup is taken first and kept, root-only)", command: `sudo "${paths.codeDir}/ctl.sh" uninstall --purge` },
  ];
}

export const status = { os: "macOS (Intel and Apple Silicon)", artifact: "launchd daemon + .pkg", tested: "OS-ISOLATION BLOCKED pending operator: the package, scripts and plist are built and statically checked on Apple Silicon (sh -n, plutil -lint, pkgutil payload/ownership), and the service logic runs here, but no launchd daemon has ever been started under a separate macOS account" };
