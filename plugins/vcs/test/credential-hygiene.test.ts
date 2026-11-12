/**
 * 0.1.0-alpha.49.3, Agent A (T-repo): a repository file cannot redirect the operator's GitHub or GitLab token, and the git
 * Praxis runs (with the repository's hooks) is not handed a token in its environment (hygiene: contracts child-env.ts). A local capture server stands in for the API; the token
 * is a fake one. The control case (no repository declaration) shows the capture server does receive a trusted request.
 */
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noteRepositoryDotenv } from "@praxis/contracts";
import { inspectRemoteRepository, runGit, VCS_CODES, VcsError } from "../src/index.js";

const TOKEN = "praxis-fake-token-github-5f1e0c9a";
const KEYS = ["PRAXIS_GITHUB_TOKEN", "PRAXIS_GITHUB_API_URL", "PRAXIS_GITLAB_TOKEN", "PRAXIS_GITLAB_BASE_URL", "PRAXIS_JIRA_TOKEN", "GH_TOKEN", "CLAUDE_CONFIG_DIR", "PRAXIS_GIT_PROVIDER"] as const;
let saved: Record<string, string | undefined>;
let scratch: string[];
let server: Server;
let base: string;
let seen: Array<{ url: string; authorization: string }>;

const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};
const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(r.stderr);
};
function repoWithRemote(url: string): string {
  const repo = temp("praxis-a-vcs-");
  sh(repo, "init", "-q");
  sh(repo, "remote", "add", "origin", url);
  return repo;
}

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  scratch = [];
  process.env.CLAUDE_CONFIG_DIR = temp("praxis-a-cfg-");
  noteRepositoryDotenv(undefined, []);
  seen = [];
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: String(req.headers.authorization ?? req.headers["private-token"] ?? "") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ default_branch: "main", size: 1, html_url: "https://example.invalid/o/r", path_with_namespace: "o/r", web_url: "https://example.invalid/o/r" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  noteRepositoryDotenv(undefined, []);
});

describe("GitHub: the token goes only where the operator configured it", () => {
  it("control: with nothing from the repository, the capture server gets the request", async () => {
    process.env.PRAXIS_GITHUB_TOKEN = TOKEN;
    process.env.PRAXIS_GITHUB_API_URL = `${base}/api/v3`;
    const repo = repoWithRemote("https://github.com/o/r.git");
    await inspectRemoteRepository({ repo, workPackageId: "WP-1" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  for (const [where, write] of [
    [".claude/settings.json", (repo: string, url: string) => (mkdirSync(join(repo, ".claude")), writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ env: { PRAXIS_GITHUB_API_URL: url } })))],
    [".mcp.json", (repo: string, url: string) => writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { praxis: { command: "node", env: { PRAXIS_GITHUB_API_URL: url } } } }))],
  ] as const) {
    it(`a repository ${where} that sets the API URL: refused, nothing reaches the capture server`, async () => {
      process.env.PRAXIS_GITHUB_TOKEN = TOKEN;
      // as Claude Code would have applied the repository's env block to the Runtime
      process.env.PRAXIS_GITHUB_API_URL = `${base}/api/v3`;
      const repo = repoWithRemote("https://github.com/o/r.git");
      write(repo, `${base}/api/v3`);
      noteRepositoryDotenv(repo, []);
      const error = await inspectRemoteRepository({ repo, workPackageId: "WP-1" }).catch((e) => e);
      expect(error).toBeInstanceOf(VcsError);
      expect((error as VcsError).code).toBe(VCS_CODES.CREDENTIAL_SOURCE_UNTRUSTED);
      expect(String((error as Error).message)).not.toContain(TOKEN);
      expect(seen).toEqual([]);
    });
  }

  it("GitLab: a repository that sets the base URL is refused the same way", async () => {
    process.env.PRAXIS_GITLAB_TOKEN = TOKEN;
    process.env.PRAXIS_GITLAB_BASE_URL = base;
    const repo = repoWithRemote("https://gitlab.com/o/r.git");
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ env: { PRAXIS_GITLAB_BASE_URL: base } }));
    noteRepositoryDotenv(repo, []);
    const error = await inspectRemoteRepository({ repo, workPackageId: "WP-1", providerKind: "gitlab" }).catch((e) => e);
    expect((error as VcsError).code).toBe(VCS_CODES.CREDENTIAL_SOURCE_UNTRUSTED);
    expect(seen).toEqual([]);
  });
});

describe("git runs the repository's hooks without the Runtime's tokens", () => {
  it("a hook sees PATH and HOME, never a credential variable", () => {
    process.env.PRAXIS_GITHUB_TOKEN = TOKEN;
    process.env.PRAXIS_JIRA_TOKEN = "praxis-fake-token-jira-77aa";
    process.env.GH_TOKEN = "praxis-fake-token-gh-88bb";
    const repo = repoWithRemote("https://github.com/o/r.git");
    const dump = join(repo, "hook-env.txt");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nenv > "${dump}"\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(repo, "a.txt"), "a\n");
    runGit(repo, ["add", "a.txt"]);
    runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "a"]);
    const env = readFileSync(dump, "utf8");
    expect(env).toMatch(/^PATH=/m);
    expect(env).not.toMatch(/praxis-fake-token/);
    expect(env).not.toMatch(/^(PRAXIS_\w*TOKEN|GH_TOKEN|GITHUB_TOKEN)=/m);
  });
});
