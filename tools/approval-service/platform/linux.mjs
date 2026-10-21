/** Linux adapter: a systemd system unit running as a dedicated system user. UNTESTED on Linux from this repository's macOS host. */
import { check, posixIsolationChecks } from "./common.mjs";

export const UNIT = "praxis-approval.service";
export const PRINCIPAL = "praxis-approval";

export function defaults() {
  return {
    id: "linux",
    principal: PRINCIPAL,
    stateDir: "/var/lib/praxis-approval",
    configFile: "/etc/praxis-approval/config.json",
    endpoint: "/run/praxis-approval/service.sock",
    codeDir: "/opt/praxis-approval-service",
    logDir: "/var/log/praxis-approval",
    unitFile: `/etc/systemd/system/${UNIT}`,
    baseDir: "/etc/praxis-approval",
  };
}

export function probe(ctx) {
  return posixIsolationChecks(ctx).concat(check("init-supervised", true, process.env.INVOCATION_ID ? "started by systemd (informational)" : "not started by systemd (informational: isolation does not depend on who started the process)"));
}

export function renderUnit(paths = defaults()) {
  return `[Unit]
Description=Praxis Approval Service (approval authority independent of the AI agent)
Documentation=file:${paths.codeDir}/current/MANIFEST.json
After=network.target

[Service]
Type=simple
User=${PRINCIPAL}
Group=${PRINCIPAL}
SupplementaryGroups=
ExecStart=${paths.codeDir}/current/node/bin/node ${paths.codeDir}/current/praxis-approval-service.mjs run --config ${paths.configFile}
Environment=PRAXIS_BUNDLE_KIND=production
Environment=PATH=/usr/bin:/bin
RuntimeDirectory=praxis-approval
RuntimeDirectoryMode=0755
StateDirectory=praxis-approval
StateDirectoryMode=0700
LogsDirectory=praxis-approval
UMask=0022
Restart=on-failure
RestartSec=2
# sandboxing: the service can write its own state and the repositories the owner names (see ReadWritePaths below), nothing else
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
ProcSubset=pid
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
ReadWritePaths=${paths.stateDir} ${paths.logDir}
# Repositories the service may write to: add with  systemctl edit praxis-approval  ->  [Service] ReadWritePaths=/path/to/repo
# (MemoryDenyWriteExecute is not set: Node's JIT needs writable+executable memory.)

[Install]
WantedBy=multi-user.target
`;
}

export function installPlan(paths = defaults()) {
  return [
    { id: "user", privileged: true, description: `Create the system user ${PRINCIPAL} (no login, no home)`, command: `useradd --system --no-create-home --shell /usr/sbin/nologin ${PRINCIPAL}` },
    { id: "package", privileged: true, description: "Check, then install the self-contained package (bundled Node, versioned directory, atomic `current` link, backup of existing state)", command: `tar -xzf praxis-approval-service-<version>-linux-<arch>.tar.gz && sh praxis-approval-service-<version>-linux-<arch>/install.sh check && sh praxis-approval-service-<version>-linux-<arch>/install.sh install` },
        { id: "health", privileged: true, description: "Verify: production mode, isolation verified, integrity ok", command: `${paths.codeDir}/current/ctl.sh health` },
    { id: "enroll", privileged: false, description: "Open an enrollment window as the service user", command: `sudo -u ${PRINCIPAL} ${paths.codeDir}/current/node/bin/node ${paths.codeDir}/current/praxis-approval-service.mjs enroll-code --config ${paths.configFile}` },
  ];
}

export function uninstallPlan(paths = defaults()) {
  return [
    { id: "stop", privileged: true, description: "Stop and disable the unit", command: `systemctl disable --now ${UNIT} && rm ${paths.unitFile} && systemctl daemon-reload` },
    { id: "backup", privileged: true, description: "Back up keys, ledger and audit", command: `tar -C /var/lib -czf ~/praxis-approval-backup.tgz praxis-approval` },
    { id: "remove", privileged: true, description: "Remove payload and, by choice only, state and the user", command: `rm -rf ${paths.codeDir}; userdel ${PRINCIPAL}` },
  ];
}

export const status = { os: "Linux (systemd distributions)", artifact: "self-contained .tar.gz (bundled official Node) + install.sh + hardened systemd unit", tested: "LINUX-CONTAINER PASS for the installer, upgrade, rollback, uninstall and the user/permission boundary (real Linux kernel, separate uids, run in a container by the build host). systemd itself (unit sandboxing, socket directory, restart) is NOT exercised: UNTESTED on a systemd host." };
