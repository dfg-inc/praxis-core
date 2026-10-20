/**
 * Windows adapter: a Windows service running as a dedicated virtual service account (NT SERVICE\PraxisApproval) with a
 * named pipe. UNTESTED: nothing here has been built or run on Windows. The pipe's DACL, which must admit the Runtime
 * client but exclude nobody it does not have to (the service never accepts approval over the pipe), and the way an
 * owner proves a pipe belongs to the service from another process, are open design questions recorded in the Work Item.
 */
import { check } from "./common.mjs";

export const SERVICE = "PraxisApproval";

export function defaults() {
  const base = "C:\\ProgramData\\Praxis\\ApprovalService";
  return {
    id: "win32",
    principal: `NT SERVICE\\${SERVICE}`,
    stateDir: `${base}\\state`,
    configFile: `${base}\\config.json`,
    endpoint: "\\\\.\\pipe\\praxis-approval-service",
    codeDir: "C:\\Program Files\\Praxis\\ApprovalService",
    logDir: `${base}\\logs`,
    unitFile: SERVICE,
    baseDir: base,
  };
}

/** Isolation cannot be verified from this code on Windows yet; the probe says so instead of guessing. */
export function probe() {
  return [check("windows-isolation-probe", false, "no Windows isolation probe is implemented: ACL inspection (icacls / GetSecurityInfo) has not been written or tested; the service reports unverified")];
}

export function renderUnit(paths = defaults()) {
  return `# Install the service (run in an elevated PowerShell; Praxis does not run this for you)
New-Service -Name ${SERVICE} -DisplayName "Praxis Approval Service" -BinaryPathName '"${paths.codeDir}\\node\\node.exe" "${paths.codeDir}\\praxis-approval-service.mjs" run --config "${paths.configFile}"' -StartupType Automatic
sc.exe config ${SERVICE} obj= "NT SERVICE\\${SERVICE}"
# Note: a plain node.exe is not a Windows service host; production needs a service wrapper (for example WinSW or NSSM). That wrapper is not chosen or tested yet.
`;
}

export function installPlan(paths = defaults()) {
  return [
    { id: "layout", privileged: true, description: "Create directories; grant the service account modify on state only, administrators full, Users read on code", command: `icacls "${paths.stateDir}" /inheritance:r /grant "NT SERVICE\\${SERVICE}:(OI)(CI)M" /grant "BUILTIN\\Administrators:(OI)(CI)F"` },
    { id: "service", privileged: true, description: "Register the service under a virtual service account", command: renderUnit(paths).split("\n").filter((l) => l && !l.startsWith("#")).join(" ; ") },
    { id: "enroll", privileged: false, description: "Enroll Windows Hello or a security key through the operator page (enrollment code from an elevated prompt)", command: `node praxis-approval-service.mjs enroll-code --config "${paths.configFile}"` },
  ];
}

export function uninstallPlan(paths = defaults()) {
  return [
    { id: "stop", privileged: true, description: "Stop and delete the service", command: `sc.exe stop ${SERVICE} ; sc.exe delete ${SERVICE}` },
    { id: "backup", privileged: true, description: "Back up state before removal", command: `Compress-Archive "${paths.stateDir}" "$HOME\\praxis-approval-backup.zip"` },
  ];
}

export const status = { os: "Windows 10/11", artifact: "service registration script (generated)", tested: "UNTESTED: no Windows build, service wrapper, pipe ACL or isolation probe has been run; only the plan text is generated" };
