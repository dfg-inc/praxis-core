/**
 * 0.1.0-alpha.49.3, Agent A: the operator's Jira token goes only to the Jira the operator configured, and praxis_doctor names
 * the credential variables this process inherited without revealing them.
 *   - T-repo: a repository .env cannot supply a token or a destination; a repository's Claude Code settings or .mcp.json that
 *     set the destination (which Claude Code applies to the Runtime's environment) refuse the token. A local capture server,
 *     handed the fake token's destination, never receives it. The control case shows it does when nothing is repository-set.
 *   - The Quality service, which runs the repository's tests, starts without any credential.
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorOp, jiraSmokeOp, loadPraxisDotenv, redact } from "./operations.js";
import { qualityServiceEnv } from "./quality-ensure.js";

const TOKEN = "praxis-fake-token-jira-c0ffee1234";
const KEYS = ["PRAXIS_JIRA_TOKEN", "PRAXIS_JIRA_BASE_URL", "PRAXIS_JIRA_PROJECT_KEY", "PRAXIS_JIRA_MODE", "PRAXIS_JIRA_EMAIL", "PRAXIS_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "PRAXIS_GITLAB_TOKEN", "PRAXIS_GIT_TOKEN", "CLAUDE_CONFIG_DIR", "PRAXIS_SKIP_DOTENV", "PRAXIS_QUALITY_PORT"] as const;
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

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  scratch = [];
  process.env.CLAUDE_CONFIG_DIR = temp("praxis-a-cfg-");
  seen = [];
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: String(req.headers.authorization ?? "") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ displayName: "x", name: "x", version: "9.12.0", deploymentType: "Server" }));
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
});

const operatorJira = (withBaseUrl = true) => {
  process.env.PRAXIS_JIRA_TOKEN = TOKEN;
  process.env.PRAXIS_JIRA_PROJECT_KEY = "PRX";
  process.env.PRAXIS_JIRA_MODE = "datacenter";
  if (withBaseUrl) process.env.PRAXIS_JIRA_BASE_URL = base;
};

async function smoke(repo: string): Promise<{ code?: string; message: string }> {
  loadPraxisDotenv(repo);
  try {
    await jiraSmokeOp({ repo });
    return { message: "ok" };
  } catch (error) {
    return { code: (error as { code?: string }).code, message: error instanceof Error ? error.message : String(error) };
  }
}

describe("the Jira token goes only where the operator configured it", () => {
  it("control: operator settings and a clean repository reach the capture server with the token", async () => {
    operatorJira();
    const repo = temp("praxis-a-jira-");
    expect((await smoke(repo)).message).toBe("ok");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("a repository .env can supply neither the destination nor a token: nothing is sent", async () => {
    operatorJira(false);
    delete process.env.PRAXIS_JIRA_TOKEN;
    const repo = temp("praxis-a-jira-");
    writeFileSync(join(repo, ".env"), `PRAXIS_JIRA_BASE_URL=${base}\nPRAXIS_JIRA_TOKEN=praxis-fake-token-from-repo-1\n`);
    const result = await smoke(repo);
    expect(result.code).toBe("JIRA_CONFIG_UNAVAILABLE");
    expect(process.env.PRAXIS_JIRA_BASE_URL).toBeUndefined();
    expect(process.env.PRAXIS_JIRA_TOKEN).toBeUndefined();
    // with the operator's token present, the repository still cannot point it anywhere
    process.env.PRAXIS_JIRA_TOKEN = TOKEN;
    expect((await smoke(repo)).code).toBe("JIRA_CONFIG_UNAVAILABLE");
    expect(seen).toEqual([]);
  });

  for (const [where, write] of [
    [".claude/settings.json", (repo: string) => (mkdirSync(join(repo, ".claude")), writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ env: { PRAXIS_JIRA_BASE_URL: base } })))],
    [".claude/settings.local.json", (repo: string) => (mkdirSync(join(repo, ".claude")), writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ env: { PRAXIS_JIRA_MODE: "datacenter" } })))],
    [".mcp.json", (repo: string) => writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { praxis: { command: "node", env: { PRAXIS_JIRA_BASE_URL: base, PRAXIS_JIRA_TOKEN: "x" } } } }))],
  ] as const) {
    it(`a repository ${where} that reaches the Runtime's environment: CREDENTIAL_SOURCE_UNTRUSTED, nothing is sent`, async () => {
      // as Claude Code would have applied the repository's env to the Runtime: the values are in the environment
      operatorJira();
      const repo = temp("praxis-a-jira-");
      write(repo);
      const result = await smoke(repo);
      expect(result.code).toBe("CREDENTIAL_SOURCE_UNTRUSTED");
      expect(result.message).toMatch(/set by a repository file/);
      expect(result.message).not.toContain(TOKEN);
      expect(seen).toEqual([]);
    });
  }
});

describe("praxis_doctor names inherited credentials, never their values", () => {
  it("credentialExposure lists the names and says what Praxis cannot do; the output carries no value", async () => {
    operatorJira();
    process.env.GH_TOKEN = "praxis-fake-token-gh-9e9e9e9e";
    const repo = temp("praxis-a-doctor-");
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ env: { PRAXIS_JIRA_BASE_URL: base } }));
    const report = (await doctorOp({ repo }, "test")) as Record<string, any>;
    expect(report.credentialExposure.inheritedCredentialVariables).toEqual(["GH_TOKEN", "PRAXIS_JIRA_TOKEN"]);
    expect(report.credentialExposure.note).toMatch(/an agent's shell included, can read these variables; Praxis cannot remove them/);
    expect(report.credentialExposure.jira).toMatchObject({ credentialInInheritedEnvironment: true, independentlyApproved: false });
    expect(report.credentialSource.jira).toMatchObject({ trusted: false, repositoryVariables: ["PRAXIS_JIRA_BASE_URL"] });
    expect(report.approval).toMatchObject({ personVerified: false, independentlyVerified: false });
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/praxis-fake-token/);
    // not even a length or a prefix
    expect(text).not.toMatch(/"(length|prefix)"/);
    expect(seen).toEqual([]);
  });

  it("the CLI's redact takes the values out of any message", () => {
    operatorJira();
    expect(redact(`Jira said: bad token ${TOKEN}`)).toBe("Jira said: bad token [REDACTED:PRAXIS_JIRA_TOKEN]");
  });
});

describe("the Quality service runs the repository's tests without credentials", () => {
  it("its environment keeps its own settings and drops every credential", () => {
    operatorJira();
    process.env.GH_TOKEN = "praxis-fake-token-gh-1";
    process.env.PRAXIS_QUALITY_PORT = "8799";
    const env = qualityServiceEnv({ ELECTRON_RUN_AS_NODE: "1" });
    expect(env.PRAXIS_QUALITY_PORT).toBe("8799");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.PATH).toBe(process.env.PATH);
    expect(JSON.stringify(env)).not.toMatch(/praxis-fake-token/);
    expect(Object.keys(env).filter((k) => /TOKEN|JIRA|GITHUB|GITLAB/.test(k))).toEqual([]);
  });
});
