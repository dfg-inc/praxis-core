/**
 * Platform-independent parts of the platform adapters: the shape of a check and the POSIX file-permission probes.
 * Adapters supply paths, an isolation probe, and install/uninstall plans as DATA. Nothing in this directory runs a
 * privileged command; plans are rendered for the owner to review and run.
 */
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { userInfo } from "node:os";

export const check = (id, ok, detail) => ({ id, ok: Boolean(ok), detail });

const DOCKER_SOCKETS = ["/var/run/docker.sock", "/run/docker.sock"];

function modeOf(path) {
  return lstatSync(path).mode & 0o777;
}

/** A path chain is sound when every existing ancestor is owned by root or the service and not writable by group/other (a sticky dir is not enough). */
export function chainProblems(path, serviceUid) {
  const problems = [];
  let current = resolve(path);
  for (;;) {
    let st;
    try {
      st = lstatSync(current);
    } catch {
      return problems; // an ancestor that does not exist yet is created by the installer, not probed here
    }
    if (st.isSymbolicLink()) problems.push(`${current} is a symbolic link`);
    if (st.uid !== 0 && st.uid !== serviceUid) problems.push(`${current} is owned by uid ${st.uid}`);
    if (st.mode & 0o022) problems.push(`${current} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
    const parent = dirname(current);
    if (parent === current) return problems;
    current = parent;
  }
}

export function posixIsolationChecks({ paths, config, env = process.env, execArgv = process.execArgv, dockerSockets = DOCKER_SOCKETS }) {
  const uid = process.getuid?.() ?? -1;
  const out = [];
  const name = userInfo().username;
  out.push(check("dedicated-principal", uid !== 0 && (!config.principal || config.principal === name), uid === 0 ? "running as root: the service must run as its own unprivileged principal" : config.principal && config.principal !== name ? `running as ${name}, configuration expects ${config.principal}` : `running as ${name} (uid ${uid})`));
  let stateOk = false;
  let stateDetail = "state directory is missing";
  try {
    const st = lstatSync(paths.stateDir);
    stateOk = st.isDirectory() && st.uid === uid && (st.mode & 0o077) === 0;
    stateDetail = stateOk ? `${paths.stateDir} is private to uid ${uid}` : `${paths.stateDir} must be a directory owned by the service with mode 0700 (is uid ${st.uid}, mode ${(st.mode & 0o777).toString(8)})`;
  } catch {
    /* keep default */
  }
  out.push(check("state-private", stateOk, stateDetail));
  // What is actually executing (resolved through any "current" link) and the install directory must both be unwritable by others.
  let running = process.argv[1] ?? paths.codeDir;
  try {
    running = realpathSync(running);
  } catch {
    /* keep the given path */
  }
  const code = [...chainProblems(paths.codeDir, uid), ...chainProblems(running, uid), ...(process.execPath ? chainProblems(realpathSync(process.execPath), uid) : [])];
  out.push(check("code-protected", code.length === 0, code.length ? [...new Set(code)].slice(0, 3).join("; ") : `${running}, ${paths.codeDir} and the Node runtime are not writable by other principals`));
  const cfg = chainProblems(paths.configFile, uid);
  out.push(check("config-protected", cfg.length === 0, cfg.length ? cfg.slice(0, 3).join("; ") : `${paths.configFile} and its parents are not writable by other principals`));
  const socketDir = dirname(paths.endpoint);
  let socketOk = false;
  try {
    const st = lstatSync(socketDir);
    socketOk = st.uid === uid && !st.isSymbolicLink() && (st.mode & 0o022) === 0;
  } catch {
    /* missing */
  }
  out.push(check("endpoint-dir-owned", socketOk, socketOk ? `${socketDir} is owned by the service and not writable by others` : `${socketDir} must be owned by the service and not writable by others`));
  const dockerReachable = dockerSockets.some((socket) => {
    try {
      accessSync(socket, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });
  out.push(check("no-docker-control", !dockerReachable, dockerReachable ? "the service identity can reach a Docker control socket" : "no Docker control socket is reachable by the service identity"));
  const hostile = Object.keys(env).filter((key) => /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|GIT_.*)$/.test(key));
  out.push(check("clean-environment", hostile.length === 0 && execArgv.length === 0, hostile.length || execArgv.length ? `unexpected process inputs: ${[...hostile, ...execArgv].join(" ")}` : "no code-injecting environment variables or Node flags"));
  return out;
}

export { modeOf, realpathSync };
