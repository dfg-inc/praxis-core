/**
 * Git as the Approval Service runs it. Never a shell, never agent-supplied argument strings: every call is an
 * argument array with an environment built from scratch, service-owned configuration and credentials, and the
 * repository's hooks and code-executing settings switched off. A repository whose local configuration could still
 * execute code or redirect credentials is refused outright (see assertRepositorySafe).
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export class GitxError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const SAFE_LOCAL_KEYS = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|safecrlf|eol|longpaths|sharedrepository)$/,
  /^remote\.[^.]+\.(url|fetch)$/,
  /^branch\.[^.]+\.(remote|merge|description)$/,
  /^user\.(name|email)$/,
  /^init\.defaultbranch$/,
  /^(pull|push|fetch|merge|rebase|diff|status|color|log|advice|gc|maintenance|submodule|http)\.(?!.*(helper|command|program|textconv|external|cmd|proxy|sslcainfo|extraheader|cookiefile)).*$/,
];

/** Service-owned git environment. `home` holds the service's own gitconfig and credential helper; nothing is inherited. */
export function gitEnvironment({ home, pathEnv, extra = {} }) {
  return {
    PATH: pathEnv || "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
    LC_ALL: "C",
    ...extra,
  };
}

export function hardeningArgs(repo, emptyHooksDir) {
  return [
    "-c", `safe.directory=${repo}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${emptyHooksDir}`,
    "-c", "core.pager=cat",
    "-c", "credential.helper=",
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "protocol.allow=never",
    "-c", "protocol.file.allow=always",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.ssh.allow=always",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=false",
  ];
}

export function runGit({ repo, args, env, emptyHooksDir, input, timeoutMs = 60_000, allowFail = false }) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      "git",
      [...hardeningArgs(repo, emptyHooksDir), "-C", repo, ...args],
      { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        const out = stdout.toString("utf8");
        const err = stderr.toString("utf8");
        if (error && !allowFail) {
          reject(new GitxError("GIT_FAILED", `git ${args[0]} failed: ${err.trim().split("\n")[0] || error.message}`, { exitCode: error.code, args0: args[0] }));
        } else resolvePromise({ stdout: out, stderr: err, code: error ? (typeof error.code === "number" ? error.code : 1) : 0 });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Parses `git config --list -z` output into [key, value] pairs (keys lower-cased as git reports them). */
export function parseConfigList(text) {
  return text
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const nl = entry.indexOf("\n");
      return nl < 0 ? [entry, ""] : [entry.slice(0, nl), entry.slice(nl + 1)];
    });
}

/**
 * `remoteUrls` are the URLs the service itself will use for this repository. A `url.<base>.insteadOf` setting only
 * matters when it would rewrite one of those: git applies rewrites to explicit URLs too, which could redirect a
 * credentialed push. A rewrite that cannot touch the service's URLs (for example a fixture that points an SSH-style
 * name at a local bare repository for the agent's own Git) is harmless to the service and is accepted.
 */
export function configProblems(entries, remoteUrls = []) {
  const problems = [];
  for (const [key, value] of entries) {
    const k = key.toLowerCase();
    if (k.startsWith("include.") || k.startsWith("includeif.")) problems.push(`${key}: included configuration is not accepted`);
    else if (/^remote\.[^.]+\.(pushurl|proxy|receivepack|uploadpack|vcs)$/.test(k)) problems.push(`${key}: redirects or executes through the remote`);
    else if (/^url\..*\.(insteadof|pushinsteadof)$/.test(k)) {
      if (value === "" || remoteUrls.some((url) => url.startsWith(value))) problems.push(`${key}: would rewrite a URL the service uses`);
    }
    else if (!SAFE_LOCAL_KEYS.some((re) => re.test(k))) problems.push(`${key}: not an accepted repository setting`);
    else if (/^remote\.[^.]+\.url$/.test(k) && /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i.test(value) && /:[^/@]*@/.test(value)) problems.push(`${key}: URL embeds credentials`);
  }
  return problems;
}

/**
 * Refuses a repository the service cannot run Git in safely. Returns the real path and a small identity record the
 * executor compares again right before it mutates anything (TOCTOU: the repository may be swapped between planning,
 * approval and execution).
 */
export function assertRepositorySafe(repoPath, { allowed }) {
  let real;
  try {
    real = realpathSync(resolve(repoPath));
  } catch {
    throw new GitxError("REPOSITORY_NOT_FOUND", "the repository does not exist");
  }
  const entry = allowed.find((candidate) => {
    try {
      return realpathSync(candidate.path) === real;
    } catch {
      return false;
    }
  });
  if (!entry) throw new GitxError("REPOSITORY_NOT_ALLOWED", "the repository is not in the service's allow-list (root-owned configuration)");
  const gitDir = join(real, ".git");
  const stat = lstatSync(gitDir, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new GitxError("REPOSITORY_UNSAFE", ".git must be a real directory (not a link or a worktree file)");
  for (const forbidden of ["commondir", "objects/info/alternates", "info/grafts", "shallow"]) {
    if (existsSync(join(gitDir, forbidden))) throw new GitxError("REPOSITORY_UNSAFE", `.git/${forbidden} is not accepted`);
  }
  if (existsSync(join(gitDir, "info", "attributes")) && readFileSync(join(gitDir, "info", "attributes"), "utf8").trim()) {
    throw new GitxError("REPOSITORY_UNSAFE", ".git/info/attributes is not accepted");
  }
  return { real, entry, gitDir, identity: `${stat.dev}:${stat.ino}` };
}

export async function readLocalConfigProblems({ real, env, emptyHooksDir, remoteUrls = [] }) {
  const { stdout } = await runGit({ repo: real, args: ["config", "--local", "--list", "-z"], env, emptyHooksDir, allowFail: true });
  return configProblems(parseConfigList(stdout), remoteUrls);
}

export function prepareHome(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const hooks = join(home, "no-hooks");
  mkdirSync(hooks, { recursive: true, mode: 0o700 });
  const cfg = join(home, "gitconfig");
  if (!existsSync(cfg)) writeFileSync(cfg, "[core]\n\tpager = cat\n[advice]\n\tdetachedHead = false\n", { mode: 0o600 });
  return { home, emptyHooksDir: hooks };
}
