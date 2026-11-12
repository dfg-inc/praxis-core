/**
 * Environments for the programs Praxis starts.
 *
 * Praxis runs repository-controlled code: test, build and coverage commands from `.project`, `npm test`, the Quality
 * service's test runs, `.praxis/quality/checks.json` modules and `.praxis/quality/adapter.mjs`, and git, which runs the
 * repository's hooks. None of it gets the environment the Runtime inherited: it gets an allowlist (repositoryCodeEnv), so a
 * credential the Runtime holds (a Jira or GitHub token from the Claude Desktop extension settings, present only in the
 * server process) never reaches it, nor does anything else the allowlist does not name. Git gets the same allowlist plus
 * what git itself needs to reach a remote with the user's own git setup (gitEnv): the ssh-agent socket, the SSH and askpass
 * programs the user configured, git's own config location and identity. Git authenticates with the user's git credential
 * helper or ssh key, never with a token Praxis holds. API calls (Jira, GitHub, GitLab) are made by the Runtime itself, each
 * with only its own credential (credential-source.ts).
 *
 * Tier: T-repo and T-sandboxed-agent writing repository code that Praxis then runs: it does not receive the Runtime's
 * credentials. It does not stop T-same-user, nor an agent whose own shell inherited the same variables (in a terminal
 * client the token is usually in the shell that started everything; see praxis_doctor credentialExposure). Repository code
 * still runs as the user, with the user's files and network.
 */

/** Variables a child needs to run as the user's tools expect: program lookup, home, locale, terminal, temp, OS. */
const BASE = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Windows
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "windir",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;
const BASE_PREFIXES = ["LC_"] as const;

/** Network settings: a proxy and the certificates to trust. A proxy URL that carries a user name or password is left out. */
const NETWORK = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;

/** What git needs to reach a remote with the user's own setup, and its identity. No token. */
const GIT = [
  "SSH_AUTH_SOCK",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
] as const;

const carriesUserInfo = (value: string): boolean => /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value.trim());

function pick(source: NodeJS.ProcessEnv, names: readonly string[], prefixes: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (names.includes(name) || prefixes.some((prefix) => name.startsWith(prefix))) out[name] = value;
  }
  return out;
}

/**
 * The environment for repository-controlled code (tests, builds, quality checks, project scripts): the allowlist above taken
 * from `source`, then `extra` (what Praxis itself sets for the run, such as CI=1).
 */
export function repositoryCodeEnv(extra: Record<string, string | undefined> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const network = Object.fromEntries(Object.entries(pick(source, NETWORK)).filter(([, value]) => !carriesUserInfo(value)));
  const env: Record<string, string> = { ...pick(source, BASE, BASE_PREFIXES), ...network };
  for (const [name, value] of Object.entries(extra)) if (typeof value === "string") env[name] = value;
  return env;
}

/** The environment for git: repositoryCodeEnv plus what git needs for the user's own remote access; never a prompt. */
export function gitEnv(extra: Record<string, string | undefined> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return repositoryCodeEnv({ ...pick(source, GIT), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: source.GIT_ASKPASS ?? "", ...extra }, source);
}
