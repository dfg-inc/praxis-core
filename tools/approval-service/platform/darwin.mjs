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
    codeDir: "/usr/local/libexec/praxis-approval-service",
    logDir: "/var/log/praxis-approval",
    unitFile: `/Library/LaunchDaemons/${LABEL}.plist`,
    baseDir: base,
  };
}

export function probe(ctx) {
  return posixIsolationChecks(ctx).concat(
    check("launchd-managed", Boolean(process.env.XPC_SERVICE_NAME) && process.env.XPC_SERVICE_NAME !== "0", process.env.XPC_SERVICE_NAME ? `launched by launchd as ${process.env.XPC_SERVICE_NAME}` : "not launched by launchd"),
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
    { id: "create-group", privileged: true, description: `Create the role group ${PRINCIPAL} (a free system GID below 500)`, command: "dseditgroup -o create -r 'Praxis Approval Service' -i <FREE_GID> " + PRINCIPAL },
    { id: "create-user", privileged: true, description: `Create the role account ${PRINCIPAL}: no login shell, no home, hidden, not in any other group, never admin`, command: `sysadminctl -addUser ${PRINCIPAL} ... (or dscl . -create /Users/${PRINCIPAL} UserShell /usr/bin/false ... IsHidden 1)` },
    { id: "layout", privileged: true, description: "Create the directories with exact ownership and modes", command: `install -d -o root -g wheel -m 0755 "${paths.baseDir}" && install -d -o ${PRINCIPAL} -g ${PRINCIPAL} -m 0700 "${paths.stateDir}" && install -d -o ${PRINCIPAL} -g ${PRINCIPAL} -m 0755 "${paths.baseDir}/run" && install -d -o ${PRINCIPAL} -g ${PRINCIPAL} -m 0750 "${paths.logDir}"` },
    { id: "payload", privileged: true, description: `Install the service payload (own Node runtime + bundled service) root-owned under ${paths.codeDir}`, command: "installer -pkg praxis-approval-service.pkg -target /" },
    { id: "config", privileged: true, description: `Write ${paths.configFile} (root-owned, mode 0644, never overwritten on upgrade) with the repository allow-list`, command: "praxis-approval-service allow-repo <path> (prints the exact ACL step per repository)" },
    { id: "launchd", privileged: true, description: `Install and start the daemon ${LABEL}`, command: `launchctl bootstrap system ${paths.unitFile}` },
    { id: "enroll", privileged: false, description: "Open an enrollment window (15 min) as the service identity and enroll Touch ID or a security key on the operator page", command: `sudo -u ${PRINCIPAL} ${paths.codeDir}/node/bin/node ${paths.codeDir}/praxis-approval-service.mjs enroll-code --config "${paths.configFile}"` },
  ];
}

export function uninstallPlan(paths = defaults()) {
  return [
    { id: "stop", privileged: true, description: "Stop and remove the daemon", command: `launchctl bootout system/${LABEL} && rm ${paths.unitFile}` },
    { id: "backup", privileged: true, description: "Back up keys, ledger and audit before removing anything (they are the only record of past approvals)", command: `tar -C "${paths.baseDir}" -czf ~/praxis-approval-backup.tgz state config.json` },
    { id: "remove-code", privileged: true, description: "Remove the payload", command: `rm -rf ${paths.codeDir}` },
    { id: "remove-state", privileged: true, description: "Remove state, logs and the role account only if the owner chooses; the default keeps them", command: `rm -rf "${paths.baseDir}" ${paths.logDir}; dscl . -delete /Users/${PRINCIPAL}; dscl . -delete /Groups/${PRINCIPAL}` },
  ];
}

export const status = { os: "macOS (Intel and Apple Silicon)", artifact: "launchd daemon + .pkg", tested: "adapter, plist and package built and statically checked on Apple Silicon; the isolation boundary itself needs the owner's one-time admin installation (BLOCKED pending operator)" };
