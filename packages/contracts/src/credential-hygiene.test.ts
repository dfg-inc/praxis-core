/**
 * 0.1.0-alpha.49.3, Agent A: credential hygiene in the shared library.
 *   - value-based redaction of every credential the process holds, in every form Praxis may emit it;
 *   - repository code and git are started with an allowlisted environment that hands them no credential (hygiene);
 *   - a credential and its destination must not come from a repository file (provenance, not a name list).
 * Fake tokens only.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv, repositoryCodeEnv } from "./child-env.js";
import { assertCredentialSource, CredentialSourceError, credentialSourceReport, noteRepositoryDotenv } from "./credential-source.js";
import { containsCredential, inheritedCredentialVariables, redactCredentials, redactCredentialsDeep, registerCredential } from "./secret-redaction.js";

const JIRA = "praxis-fake-token-jira-0123456789";
const GH = "praxis-fake-token-gh+/=ab\"c\\d-xyz";
const NAMES = ["PRAXIS_JIRA_TOKEN", "PRAXIS_JIRA_EMAIL", "PRAXIS_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "PRAXIS_GITLAB_TOKEN", "PRAXIS_GIT_TOKEN", "HTTPS_PROXY", "SSH_AUTH_SOCK", "AWS_SECRET_ACCESS_KEY", "CLAUDE_CONFIG_DIR"] as const;
let saved: Record<string, string | undefined>;
let scratch: string[];
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));
  for (const k of NAMES) delete process.env[k];
  scratch = [];
  process.env.CLAUDE_CONFIG_DIR = temp("praxis-a-claude-"); // a user config of the test's own
  noteRepositoryDotenv(undefined, []);
});
afterEach(() => {
  for (const k of NAMES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  noteRepositoryDotenv(undefined, []);
});

describe("value-based redaction", () => {
  it("replaces each credential the process holds, in every form Praxis may emit it", () => {
    process.env.PRAXIS_JIRA_TOKEN = JIRA;
    process.env.PRAXIS_JIRA_EMAIL = "someone@example.invalid";
    process.env.GH_TOKEN = GH;
    const basic = Buffer.from(`someone@example.invalid:${JIRA}`).toString("base64");
    const text = [
      `raw ${JIRA}`,
      `json ${JSON.stringify({ t: GH })}`,
      `url ?t=${encodeURIComponent(GH)}`,
      `b64 ${Buffer.from(JIRA).toString("base64")}`,
      `Authorization: Basic ${basic}`,
    ].join("\n");
    const out = redactCredentials(text);
    expect(out).not.toContain(JIRA);
    expect(out).not.toContain(GH);
    expect(out).not.toContain(JSON.stringify(GH).slice(1, -1));
    expect(out).not.toContain(encodeURIComponent(GH));
    expect(out).not.toContain(basic);
    expect(out).toContain("[REDACTED:PRAXIS_JIRA_TOKEN]");
    expect(out).toContain("[REDACTED:GH_TOKEN]");
    expect(containsCredential(text)).toBe(true);
    expect(containsCredential(out)).toBe(false);
    // a JSON document stays valid JSON
    const doc = JSON.stringify({ message: `echo ${GH}`, nested: [{ [JIRA]: JIRA }] });
    expect(() => JSON.parse(redactCredentials(doc))).not.toThrow();
  });

  it("walks objects, arrays and errors without changing the original", () => {
    process.env.PRAXIS_GITHUB_TOKEN = JIRA;
    const original = { a: [JIRA, { b: `x${JIRA}y` }], e: new Error(`failed with ${JIRA}`), n: 1, ok: true };
    const copy = redactCredentialsDeep(original);
    expect(JSON.stringify(copy)).not.toContain(JIRA);
    expect((copy.e as Error).message).toBe("failed with [REDACTED:PRAXIS_GITHUB_TOKEN]");
    expect(original.a[0]).toBe(JIRA);
    expect(copy.n).toBe(1);
  });

  it("covers a credential registered from configuration, and leaves short values alone", () => {
    registerCredential("QUALITY_CONFIG_TOKEN", "praxis-fake-token-config-42");
    expect(redactCredentials("t=praxis-fake-token-config-42")).toBe("t=[REDACTED:QUALITY_CONFIG_TOKEN]");
    process.env.GITLAB_TOKEN = "short";
    expect(redactCredentials("a short word")).toBe("a short word");
  });

  it("names the credential variables present, never their values; a blank Desktop placeholder is not one", () => {
    process.env.PRAXIS_JIRA_TOKEN = JIRA;
    process.env.PRAXIS_GITHUB_TOKEN = "${user_config.github_token}";
    expect(inheritedCredentialVariables()).toEqual(["PRAXIS_JIRA_TOKEN"]);
  });
});

describe("child environments", () => {
  it("repository code gets the allowlist only: no credential, no Praxis setting, no proxy password", () => {
    const source = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/u",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      TMPDIR: "/tmp",
      PRAXIS_JIRA_TOKEN: JIRA,
      GH_TOKEN: GH,
      GITHUB_TOKEN: GH,
      AWS_SECRET_ACCESS_KEY: "praxis-fake-token-aws",
      NODE_OPTIONS: "--require /tmp/x.js",
      PRAXIS_STATE_HOME: "/x",
      HTTPS_PROXY: "http://user:praxis-fake-token-proxy@proxy.example.invalid:3128",
      NO_PROXY: "localhost",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    };
    const env = repositoryCodeEnv({ CI: "1" }, source);
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "C.UTF-8", LC_ALL: "C", TMPDIR: "/tmp", NO_PROXY: "localhost", CI: "1" });
    const forGit = gitEnv({}, source);
    expect(forGit.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(forGit.GIT_TERMINAL_PROMPT).toBe("0");
    expect(JSON.stringify(forGit)).not.toMatch(/praxis-fake-token/);
    expect(forGit.NODE_OPTIONS).toBeUndefined();
  });
});

describe("a credential and its destination come from the same source", () => {
  it("a repository's Claude Code settings that set the destination refuse the credential", () => {
    const repo = temp("praxis-a-src-");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ env: { PRAXIS_JIRA_BASE_URL: "http://127.0.0.1:9" } }));
    expect(() => assertCredentialSource("jira", repo)).toThrow(CredentialSourceError);
    try {
      assertCredentialSource("jira", repo);
    } catch (error) {
      expect((error as CredentialSourceError).details).toEqual({ provider: "jira", variables: ["PRAXIS_JIRA_BASE_URL"], files: [join(repo, ".claude", "settings.json")] });
      expect((error as Error).message).not.toContain("127.0.0.1");
    }
    expect(() => assertCredentialSource("github", repo)).not.toThrow();
  });

  it("so do an .mcp.json server env, a local settings file, a supplied token and an unreadable file", () => {
    const repo = temp("praxis-a-src-");
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { praxis: { command: "node", env: { PRAXIS_GITHUB_API_URL: "http://127.0.0.1:9/api/v3" } } } }));
    expect(() => assertCredentialSource("github", repo)).toThrow(/PRAXIS_GITHUB_API_URL/);
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.local.json"), `{ // a comment\n "env": { "PRAXIS_GITLAB_TOKEN": "x", } }`);
    expect(() => assertCredentialSource("gitlab", repo)).toThrow(/PRAXIS_GITLAB_TOKEN/);
    writeFileSync(join(repo, ".claude", "settings.json"), "{ not json");
    expect(() => assertCredentialSource("jira", repo)).toThrow(/settings\.json/);
    expect(credentialSourceReport(repo)).toMatchObject({ jira: { trusted: false }, github: { trusted: false }, gitlab: { trusted: false } });
  });

  it("a value a repository .env put into the environment counts as the repository's", () => {
    const repo = temp("praxis-a-src-");
    noteRepositoryDotenv(repo, [["PRAXIS_JIRA_EMAIL", join(repo, ".env")]]);
    expect(() => assertCredentialSource("jira")).toThrow(/PRAXIS_JIRA_EMAIL/);
    noteRepositoryDotenv(repo, []);
    expect(() => assertCredentialSource("jira")).not.toThrow();
  });

  it("the user's own Claude Code settings are the operator's, not the repository's", () => {
    // a home-like folder whose .claude is the user's configuration, with the repository below it
    const home = temp("praxis-a-home-");
    const repo = join(home, "work", "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { PRAXIS_JIRA_BASE_URL: "https://jira.example.invalid" } }));
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    expect(() => assertCredentialSource("jira", repo)).not.toThrow();
    // the same file one level down, in a folder above the repository, is project scope
    mkdirSync(join(home, "work", ".claude"));
    writeFileSync(join(home, "work", ".claude", "settings.json"), JSON.stringify({ env: { PRAXIS_JIRA_BASE_URL: "https://jira.example.invalid" } }));
    expect(() => assertCredentialSource("jira", repo)).toThrow(CredentialSourceError);
  });
});
