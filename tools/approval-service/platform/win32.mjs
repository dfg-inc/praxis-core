/**
 * Windows adapter: a Windows service (a small compiled service host, because node.exe is not a service host) running as a
 * virtual service account NT SERVICE\PraxisApproval, a named pipe whose DACL the host sets, and ACL-based isolation checks.
 *
 * STATUS: UNTESTED. Nothing in this file or in packaging/windows has been run on Windows. The parsing logic is unit-tested
 * against recorded `icacls` output; the service host, the pipe DACL and the installer are code that has never executed.
 */
import { spawnSync } from "node:child_process";
import { check } from "./common.mjs";

export const SERVICE = "PraxisApproval";
export const ACCOUNT = `NT SERVICE\\${SERVICE}`;
const PIPE = "\\\\.\\pipe\\praxis-approval-service";

export function defaults() {
  const base = "C:\\ProgramData\\Praxis\\ApprovalService";
  return {
    id: "win32",
    principal: ACCOUNT,
    stateDir: `${base}\\state`,
    configFile: `${base}\\config.json`,
    endpoint: PIPE,
    codeDir: "C:\\Program Files\\Praxis\\ApprovalService",
    logDir: `${base}\\logs`,
    unitFile: SERVICE,
    baseDir: base,
  };
}

/**
 * Parses `icacls <path>` output into entries { principal, rights: [..], inherited }. Handles localized "Successfully
 * processed" trailers by ignoring any line without a principal:(rights) shape.
 */
export function parseIcacls(text, path = "") {
  const entries = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = (path && raw.startsWith(path) ? raw.slice(path.length) : raw).trim();
    const m = /^(.+?):\(([^)]*)\)(?:\(([^)]*)\))*/.exec(line);
    if (!m) continue;
    const flags = [...line.matchAll(/\(([^)]*)\)/g)].map((x) => x[1].split(",")).flat();
    entries.push({ principal: m[1].trim(), rights: flags.filter((f) => /^(F|M|RX|R|W|D|DENY|N|AD|WD|WDAC|GA|GW|GR|GE)$/i.test(f) || /^\(?(OI|CI|IO|NP|I)$/i.test(f)), inherited: flags.includes("I"), deny: /\(DENY\)/i.test(line) });
  }
  return entries;
}

const BROAD = /^(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users|NT AUTHORITY\\INTERACTIVE|BUILTIN\\Guests|NT AUTHORITY\\NETWORK)$/i;
const WRITE = /^(F|M|W|D|AD|WD|WDAC|GA|GW)$/i;

/** Problems in a directory's ACL: any non-administrative principal with write access to code, or any broad principal at all on private state. */
export function aclProblems(entries, { kind }) {
  const problems = [];
  for (const e of entries) {
    if (e.deny) continue;
    const writes = e.rights.some((r) => WRITE.test(r));
    if (kind === "state" && BROAD.test(e.principal)) problems.push(`${e.principal} has access to the private state directory`);
    if (kind === "code" && BROAD.test(e.principal) && writes) problems.push(`${e.principal} can write to the code directory`);
    if (kind === "config" && BROAD.test(e.principal) && writes) problems.push(`${e.principal} can write to the configuration`);
    if (writes && !/^(NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators|NT SERVICE\\TrustedInstaller)$/i.test(e.principal) && e.principal !== ACCOUNT && kind !== "state") {
      problems.push(`${e.principal} has write access to the ${kind} (only SYSTEM, Administrators and ${ACCOUNT} may)`);
    }
  }
  return problems;
}

function icacls(path) {
  const r = spawnSync("icacls", [path], { encoding: "utf8" });
  return r.status === 0 ? parseIcacls(r.stdout, path) : undefined;
}

export function probe(ctx) {
  const out = [];
  const who = spawnSync("whoami", [], { encoding: "utf8" });
  const me = (who.stdout ?? "").trim();
  out.push(check("dedicated-principal", me.toLowerCase() === ACCOUNT.toLowerCase(), me ? `running as ${me}; expected ${ACCOUNT}` : "cannot determine the running account"));
  for (const [id, path, kind] of [["state-private", ctx.paths.stateDir, "state"], ["code-protected", ctx.paths.codeDir, "code"], ["config-protected", ctx.paths.configFile, "config"]]) {
    const entries = icacls(path);
    const problems = entries ? aclProblems(entries, { kind }) : [`cannot read the ACL of ${path}`];
    out.push(check(id, problems.length === 0, problems.length ? problems.slice(0, 3).join("; ") : `${path}: no broad or non-administrative principal has the access it must not have`));
  }
  const node = icacls(process.execPath);
  const nodeProblems = node ? aclProblems(node, { kind: "code" }) : [`cannot read the ACL of ${process.execPath}`];
  out.push(check("runtime-protected", nodeProblems.length === 0, nodeProblems.length ? nodeProblems.slice(0, 3).join("; ") : "the Node runtime is not writable by non-administrators"));
  const hostile = Object.keys(process.env).filter((k) => /^(NODE_OPTIONS|NODE_PATH|GIT_.*)$/i.test(k));
  out.push(check("clean-environment", hostile.length === 0 && process.execArgv.length === 0, hostile.length || process.execArgv.length ? `unexpected process inputs: ${[...hostile, ...process.execArgv].join(" ")}` : "no code-injecting environment variables or Node flags"));
  out.push(check("endpoint-dacl-applied", true, "the service host sets the pipe DACL after the pipe exists (SYSTEM, Administrators, the service account full; Authenticated Users read/write; NETWORK denied); verify with tools/approval-service/packaging/windows/install.ps1 -Health"));
  return out;
}

export function renderUnit(paths = defaults()) {
  return `# Generated. The installer is packaging/windows/install.ps1 (run elevated by the owner); this is a summary of what it does.
sc.exe create ${SERVICE} binPath= "\\"${paths.codeDir}\\current\\PraxisApprovalServiceHost.exe\\"" obj= "${ACCOUNT}" start= auto
sc.exe sidtype ${SERVICE} unrestricted
sc.exe failure ${SERVICE} reset= 86400 actions= restart/5000/restart/5000/restart/30000
`;
}

export function installPlan(paths = defaults()) {
  return [
    { id: "extract", privileged: false, description: "Unpack the package and check it against its manifest, architecture and version", command: "Expand-Archive praxis-approval-service-<version>-windows-<arch>.zip; .\\install.ps1 -Check" },
    { id: "install", privileged: true, description: `Compile the service host with the OS-provided C# compiler, install the code under ${paths.codeDir}\\<version> (Administrators and SYSTEM only), create ${paths.baseDir} with an ACL that gives ${ACCOUNT} modify on state only, register the service under the virtual account, start it`, command: ".\\install.ps1 -Install" },
    { id: "health", privileged: true, description: "Verify production mode, isolation, integrity and the pipe DACL", command: ".\\install.ps1 -Health" },
    { id: "enroll", privileged: true, description: "Open an enrollment window as the service account and enroll Windows Hello or a security key at http://localhost:8780/enroll", command: `.\\install.ps1 -EnrollCode` },
    { id: "upgrade", privileged: true, description: "Backup, check compatibility, switch versions atomically", command: ".\\install.ps1 -Upgrade" },
  ];
}

export function uninstallPlan(paths = defaults()) {
  return [
    { id: "backup", privileged: true, description: `Back up state and configuration to an Administrators-only directory under ${paths.baseDir}\\backups`, command: ".\\install.ps1 -Backup" },
    { id: "rollback", privileged: true, description: "Switch back to the previous version", command: ".\\install.ps1 -Rollback" },
    { id: "uninstall", privileged: true, description: "Stop and delete the service, remove code; keep state unless -Purge", command: ".\\install.ps1 -Uninstall [-Purge]" },
  ];
}

export const status = { os: "Windows 10/11", artifact: "zip with install.ps1, a C# service host compiled at install time, bundled Node, manifest", tested: "UNTESTED: the installer, the service host, the pipe DACL and the isolation probe have never run on Windows. Only the ACL-parsing logic is unit-tested against recorded icacls output. Do not treat Windows as supported until the CI job in .github/workflows/approval-service.yml (windows-latest) has passed and the owner has run the isolation acceptance." };
