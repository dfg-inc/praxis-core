import { readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * A credential and the destination it is sent to come from the same trust source, or the credential is not used.
 *
 * A token is configured by the operator: the Claude Desktop extension settings, the user's shell, `claude mcp add -e`, or the
 * user's own Claude Code settings. Its destination (the Jira base URL, the GitHub API URL, the GitLab base URL) and the
 * settings that decide how it is sent must come from the same place. A repository cannot supply either: its `.env` files
 * (the CLI's loader reports what it took from them), and the project-scope Claude Code files whose `env` reaches the
 * Runtime's environment (`.claude/settings.json`, `.claude/settings.local.json`, the `env` of `.mcp.json` servers) in the
 * working folder, the repository and the folders above them. When any variable of a binding is declared by such a file, the
 * credential is refused before a request is built (CREDENTIAL_SOURCE_UNTRUSTED), whatever the value: Praxis cannot tell
 * whether the value it sees came from that file or from the operator, so it does not guess. A file that exists but cannot be
 * read or parsed counts as declaring everything (fail closed).
 *
 * This is provenance, not a list of forbidden names: whatever variable a repository file sets is treated as the
 * repository's, and a binding is usable only when none of its variables is.
 *
 * Tier: T-repo (a cloned repository, a merged pull request, repository Claude Code settings) cannot redirect a user's
 * credential to a host of its choosing, nor supply a token that Praxis then uses as authorization. It does not stop
 * T-sandboxed-agent or T-same-user, which can read the inherited environment and send the token anywhere themselves.
 */

export type CredentialProvider = "jira" | "github" | "gitlab";
export type CredentialBinding = { provider: CredentialProvider; credential: string; destination: readonly string[] };

/** Each credential with the variables that decide where and how it is sent. */
export const CREDENTIAL_BINDINGS: Readonly<Record<CredentialProvider, CredentialBinding>> = {
  jira: { provider: "jira", credential: "PRAXIS_JIRA_TOKEN", destination: ["PRAXIS_JIRA_BASE_URL", "PRAXIS_JIRA_EMAIL", "PRAXIS_JIRA_MODE", "PRAXIS_JIRA_AUTH"] },
  github: { provider: "github", credential: "PRAXIS_GITHUB_TOKEN", destination: ["PRAXIS_GITHUB_API_URL"] },
  gitlab: { provider: "gitlab", credential: "PRAXIS_GITLAB_TOKEN", destination: ["PRAXIS_GITLAB_BASE_URL"] },
};

export class CredentialSourceError extends Error {
  readonly code = "CREDENTIAL_SOURCE_UNTRUSTED" as const;
  readonly details: { provider: CredentialProvider; variables: string[]; files: string[] };
  constructor(binding: CredentialBinding, found: Map<string, string[]>) {
    const variables = [...found.keys()].sort();
    const files = [...new Set([...found.values()].flat())].sort();
    super(
      `CREDENTIAL_SOURCE_UNTRUSTED: ${binding.credential} was not used: ${variables.join(", ")} ${variables.length === 1 ? "is" : "are"} set by a repository file (${files.join("; ")}). A repository may not choose where a credential is sent, nor supply one. Nothing was sent. Remove ${variables.length === 1 ? "it" : "them"} from the repository file and configure the ${binding.provider} settings together with the token: in the Claude Desktop extension settings, your shell, or your user Claude Code settings.`,
    );
    this.name = "CredentialSourceError";
    this.details = { provider: binding.provider, variables, files };
  }
}

const MAX_SETTINGS = 16 * 1024 * 1024;
const caseless = process.platform === "win32";
const norm = (name: string): string => (caseless ? name.toUpperCase() : name);

/** Comments and trailing commas removed outside strings, as a lenient settings reader accepts them. */
function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === "\\") i += 1;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The parsed file, undefined when absent, or "unreadable" when it exists and cannot be fully read. */
function readJson(path: string): unknown | "unreadable" | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_SETTINGS) return "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
  }
  try {
    return JSON.parse(stripJsonc(readFileSync(path, "utf8").replace(/^﻿/, "")));
  } catch {
    return "unreadable";
  }
}

const envKeys = (value: unknown): string[] => (value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as object) : []);

/** The folders whose Claude Code files are project scope: the working folder, the repository and every folder above them. */
function projectFolders(repo: string | undefined): string[] {
  const folders = new Set<string>();
  for (const start of [process.cwd(), ...(repo ? [repo] : [])]) {
    let dir = resolve(start);
    for (let i = 0; i < 64; i += 1) {
      folders.add(dir);
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return [...folders];
}

let notedRepo: string | undefined;
let notedDotenv = new Map<string, string[]>();

/** The CLI's .env loader reports what it put into the environment from a repository file, for the repository of this call. */
export function noteRepositoryDotenv(repo: string | undefined, loaded: Iterable<readonly [string, string]>): void {
  notedRepo = repo ? resolve(repo) : undefined;
  notedDotenv = new Map();
  for (const [name, file] of loaded) notedDotenv.set(norm(name), [...(notedDotenv.get(norm(name)) ?? []), file]);
}

/**
 * The variables a repository file sets in the Runtime's environment, with the files that set them. `everything` is set when a
 * project-scope file exists but cannot be read: then any variable may come from it.
 */
export function repositorySourcedVariables(repo: string | undefined = notedRepo): { variables: Map<string, string[]>; everything: string[] } {
  const variables = new Map<string, string[]>();
  const everything: string[] = [];
  const add = (name: string, file: string) => variables.set(norm(name), [...new Set([...(variables.get(norm(name)) ?? []), file])]);
  // the user's own Claude Code configuration is the operator's, not the repository's
  const userConfig = new Set([...new Set([homedir(), userInfo().homedir].filter(Boolean))].map((home) => resolve(home, ".claude")));
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) userConfig.add(resolve(process.env.CLAUDE_CONFIG_DIR.trim()));
  for (const folder of projectFolders(repo)) {
    const claude = join(folder, ".claude");
    if (!userConfig.has(claude)) {
      for (const name of ["settings.json", "settings.local.json"]) {
        const file = join(claude, name);
        const parsed = readJson(file);
        if (parsed === "unreadable") everything.push(file);
        else if (parsed && typeof parsed === "object") for (const key of envKeys((parsed as Record<string, unknown>).env)) add(key, file);
      }
    }
    const mcp = join(folder, ".mcp.json");
    const servers = readJson(mcp);
    if (servers === "unreadable") everything.push(mcp);
    else if (servers && typeof servers === "object") {
      const list = (servers as Record<string, unknown>).mcpServers;
      if (list && typeof list === "object") for (const server of Object.values(list as Record<string, unknown>)) for (const key of envKeys((server as Record<string, unknown> | null)?.env)) add(key, mcp);
    }
  }
  if (!repo || resolve(repo) === notedRepo) for (const [name, files] of notedDotenv) for (const file of files) add(name, file);
  return { variables, everything };
}

/**
 * Throws CredentialSourceError unless the credential of `provider` and every variable that decides where it goes come from
 * outside the repository. Called where the credential is paired with its destination, before any request is built.
 */
export function assertCredentialSource(provider: CredentialProvider, repo?: string): void {
  const binding = CREDENTIAL_BINDINGS[provider];
  const { variables, everything } = repositorySourcedVariables(repo);
  const found = new Map<string, string[]>();
  for (const name of [binding.credential, ...binding.destination]) {
    const files = [...(variables.get(norm(name)) ?? []), ...everything];
    if (files.length) found.set(name, files);
  }
  if (found.size) throw new CredentialSourceError(binding, found);
}

/** The same check as a report for praxis_doctor: per provider, the variables a repository file sets (names and files only). */
export function credentialSourceReport(repo?: string): Record<CredentialProvider, { trusted: boolean; repositoryVariables: string[]; files: string[] }> {
  const out = {} as Record<CredentialProvider, { trusted: boolean; repositoryVariables: string[]; files: string[] }>;
  for (const provider of Object.keys(CREDENTIAL_BINDINGS) as CredentialProvider[]) {
    try {
      assertCredentialSource(provider, repo);
      out[provider] = { trusted: true, repositoryVariables: [], files: [] };
    } catch (error) {
      const details = (error as CredentialSourceError).details;
      out[provider] = { trusted: false, repositoryVariables: details?.variables ?? [], files: details?.files ?? [] };
    }
  }
  return out;
}
