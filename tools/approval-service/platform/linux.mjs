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
  return posixIsolationChecks(ctx).concat(check("systemd-managed", Boolean(process.env.INVOCATION_ID), process.env.INVOCATION_ID ? "started by systemd" : "not started by systemd"));
}

export function renderUnit(paths = defaults()) {
  return `[Unit]
Description=Praxis Approval Service (approval authority independent of the AI agent)
After=network.target

[Service]
Type=simple
User=${PRINCIPAL}
Group=${PRINCIPAL}
ExecStart=${paths.codeDir}/node/bin/node ${paths.codeDir}/praxis-approval-service.mjs run --config ${paths.configFile}
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
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=${paths.stateDir}
# Repositories the service may write to are added with: systemctl edit ${UNIT}  (ReadWritePaths=<repo>)

[Install]
WantedBy=multi-user.target
`;
}

export function installPlan(paths = defaults()) {
  return [
    { id: "user", privileged: true, description: `Create the system user ${PRINCIPAL} (no login, no home)`, command: `useradd --system --no-create-home --shell /usr/sbin/nologin ${PRINCIPAL}` },
    { id: "payload", privileged: true, description: `Install the payload root-owned under ${paths.codeDir}`, command: `install -d -o root -g root -m 0755 ${paths.codeDir} && cp -a payload/. ${paths.codeDir}/` },
    { id: "config", privileged: true, description: `Write ${paths.configFile} root-owned 0644`, command: `install -D -o root -g root -m 0644 config.json ${paths.configFile}` },
    { id: "unit", privileged: true, description: "Install and start the unit", command: `install -m 0644 ${UNIT} ${paths.unitFile} && systemctl daemon-reload && systemctl enable --now ${UNIT}` },
    { id: "enroll", privileged: false, description: "Open an enrollment window as the service user", command: `sudo -u ${PRINCIPAL} ${paths.codeDir}/node/bin/node ${paths.codeDir}/praxis-approval-service.mjs enroll-code --config ${paths.configFile}` },
  ];
}

export function uninstallPlan(paths = defaults()) {
  return [
    { id: "stop", privileged: true, description: "Stop and disable the unit", command: `systemctl disable --now ${UNIT} && rm ${paths.unitFile} && systemctl daemon-reload` },
    { id: "backup", privileged: true, description: "Back up keys, ledger and audit", command: `tar -C /var/lib -czf ~/praxis-approval-backup.tgz praxis-approval` },
    { id: "remove", privileged: true, description: "Remove payload and, by choice only, state and the user", command: `rm -rf ${paths.codeDir}; userdel ${PRINCIPAL}` },
  ];
}

export const status = { os: "Linux (systemd distributions)", artifact: "systemd unit + install script", tested: "UNTESTED: unit and plan are generated and checked statically on macOS only; no Linux build or boundary test has been run" };
