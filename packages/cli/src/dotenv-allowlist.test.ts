import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dotenvKeyAllowed, dotenvRejectedKeys, loadPraxisDotenv } from "./operations.js";

/** Everything below is in a file the agent can write. None of it may reach the Runtime's trusted configuration. */
const FORBIDDEN = [
  "PRAXIS_APPROVAL_MODE", "PRAXIS_APPROVAL_STRICT", "PRAXIS_APPROVAL_FORGED", "PRAXIS_TEST_APPROVALS", "PRAXIS_TEST_REVIEW_NO_BROWSER", "PRAXIS_TEST_ANYTHING",
  "PRAXIS_REVIEW_X", "PRAXIS_FIXTURE_EXECUTION", "PRAXIS_ALLOW_DOCKER_SOCKET", "PRAXIS_STATE_HOME", "PRAXIS_SKIP_DOTENV", "PRAXIS_QA_ALLOW_TEST_WRITES",
  "PRAXIS_JIRA_BASE_URL", "PRAXIS_JIRA_TOKEN", "PRAXIS_JIRA_EMAIL", "PRAXIS_JIRA_AUTH", "PRAXIS_JIRA_CLOUD_ID", "PRAXIS_JIRA_MODE", "PRAXIS_ISSUE_PROPERTIES",
  "PRAXIS_GITLAB_BASE_URL", "PRAXIS_GITLAB_TOKEN", "PRAXIS_GITHUB_TOKEN", "PRAXIS_GITHUB_API_URL",
  "PRAXIS_QUALITY_URL", "PRAXIS_QUALITY_ENTRY", "PRAXIS_QUALITY_NODE", "PRAXIS_QUALITY_PORT", "PRAXIS_QUALITY_DB", "PRAXIS_QUALITY_ALLOWED_ROOT", "PRAXIS_QUALITY_SIMULATED_EXEC_PATH",
  "PRAXIS_CLAUDE_BIN", "PRAXIS_BUNDLE_KIND", "PRAXIS_BROKER", "PRAXIS_SECURITY_MODE",
  "BROWSER", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "GIT_ASKPASS", "PATH", "HOME", "XDG_CONFIG_HOME", "HTTPS_PROXY",
];
const ALLOWED = ["PRAXIS_JIRA_PROJECT_KEY", "PRAXIS_JIRA_STORY_TYPE", "PRAXIS_JIRA_TRANSITION_DONE", "PRAXIS_GIT_PROVIDER", "PRAXIS_WORK_PACKAGE_MAX_HOURS"];

let saved: Record<string, string | undefined>;
const ALL = [...FORBIDDEN, ...ALLOWED];
beforeEach(() => {
  saved = Object.fromEntries(ALL.map((k) => [k, process.env[k]]));
  for (const k of ALL) if (k !== "PATH" && k !== "HOME") delete process.env[k];
  delete process.env.PRAXIS_SKIP_DOTENV;
});
afterEach(() => {
  for (const k of ALL) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "praxis-allow-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}
const lines = (keys: string[], value = "evil") => keys.map((k) => `${k}=${value}`).join("\n");

describe("repository files configure Praxis only through an allowlist", () => {
  for (const file of [".env", ".env.praxis", ".env.praxis.local"]) {
    it(`${file}: no trust, credential, routing, execution or journal setting is loaded`, () => {
      const before = { PATH: process.env.PATH, HOME: process.env.HOME };
      loadPraxisDotenv(repo({ [file]: lines(FORBIDDEN.filter((k) => k !== "PATH" && k !== "HOME"), "/tmp/evil") }));
      for (const k of FORBIDDEN) if (k !== "PATH" && k !== "HOME") expect(process.env[k], k).toBeUndefined();
      expect(process.env.PATH).toBe(before.PATH);
      expect(process.env.HOME).toBe(before.HOME);
      expect(process.env.PRAXIS_SKIP_DOTENV).toBeUndefined();
    });
  }

  it("the explicit trust cases from the review: trusted-client, test approvals, forged approvals, strict off", () => {
    loadPraxisDotenv(repo({ ".env": "PRAXIS_APPROVAL_MODE=trusted-client\nPRAXIS_TEST_APPROVALS=1\nPRAXIS_APPROVAL_FORGED=1\nPRAXIS_APPROVAL_STRICT=0\nPRAXIS_APPROVAL_MODE=host-permission\n" }));
    expect(process.env.PRAXIS_APPROVAL_MODE).toBeUndefined();
    expect(process.env.PRAXIS_TEST_APPROVALS).toBeUndefined();
    expect(process.env.PRAXIS_APPROVAL_FORGED).toBeUndefined();
    expect(process.env.PRAXIS_APPROVAL_STRICT).toBeUndefined();
    expect(dotenvRejectedKeys()).toEqual(expect.arrayContaining(["PRAXIS_APPROVAL_MODE", "PRAXIS_TEST_APPROVALS"]));
  });

  it("only the allowlisted per-project naming settings load, and only with a value of the right shape", () => {
    const GOOD: Record<string, string> = { PRAXIS_JIRA_PROJECT_KEY: "PRX", PRAXIS_JIRA_STORY_TYPE: "User Story", PRAXIS_JIRA_TRANSITION_DONE: "Done", PRAXIS_GIT_PROVIDER: "github", PRAXIS_WORK_PACKAGE_MAX_HOURS: "16" };
    loadPraxisDotenv(repo({ ".env": ALLOWED.map((k) => `${k}=${GOOD[k]}`).join("\n") }));
    for (const k of ALLOWED) expect(process.env[k], k).toBe(GOOD[k]);
    for (const k of ALLOWED) expect(dotenvKeyAllowed(k)).toBe(true);
    for (const k of FORBIDDEN) expect(dotenvKeyAllowed(k), k).toBe(false);
  });

  it("priority: the operator's real environment wins over every file; among files the first one read wins", () => {
    process.env.PRAXIS_JIRA_PROJECT_KEY = "FROM_OPERATOR";
    loadPraxisDotenv(repo({ ".env.praxis": "PRAXIS_JIRA_PROJECT_KEY=FILE1\nPRAXIS_GIT_PROVIDER=github", ".env": "PRAXIS_JIRA_PROJECT_KEY=FILE2\nPRAXIS_GIT_PROVIDER=gitlab", ".env.praxis.local": "PRAXIS_GIT_PROVIDER=github" }));
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBe("FROM_OPERATOR");
    expect(process.env.PRAXIS_GIT_PROVIDER).toBe("github");
    delete process.env.PRAXIS_GIT_PROVIDER;
  });

  it("PRAXIS_SKIP_DOTENV=1 in the real environment stops all loading; a file cannot set or clear it", () => {
    process.env.PRAXIS_SKIP_DOTENV = "1";
    loadPraxisDotenv(repo({ ".env": "PRAXIS_JIRA_PROJECT_KEY=X\nPRAXIS_SKIP_DOTENV=0" }));
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBeUndefined();
    expect(process.env.PRAXIS_SKIP_DOTENV).toBe("1");
  });

  it("nested configuration files are not read: only the three files at the repository root", () => {
    const dir = repo({
      "sub/.env": "PRAXIS_JIRA_PROJECT_KEY=NESTED\nPRAXIS_APPROVAL_MODE=trusted-client",
      ".praxis/.env": "PRAXIS_JIRA_PROJECT_KEY=NESTED2\nPRAXIS_TEST_APPROVALS=1",
      "config/.env.praxis": "PRAXIS_JIRA_PROJECT_KEY=NESTED3",
      ".project": "approvalMode: trusted-client\nPRAXIS_APPROVAL_MODE=trusted-client\n",
      ".praxis/config.json": JSON.stringify({ PRAXIS_APPROVAL_MODE: "trusted-client", env: { PRAXIS_TEST_APPROVALS: "1" } }),
    });
    loadPraxisDotenv(dir);
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBeUndefined();
    expect(process.env.PRAXIS_APPROVAL_MODE).toBeUndefined();
    expect(process.env.PRAXIS_TEST_APPROVALS).toBeUndefined();
  });

  it("shell-style tricks do not smuggle a key in: export prefix, lower case, spaces, quotes, CRLF, duplicates", () => {
    loadPraxisDotenv(repo({ ".env": "export PRAXIS_APPROVAL_MODE=trusted-client\npraxis_approval_mode=trusted-client\nPRAXIS_APPROVAL_MODE =trusted-client\n PRAXIS_APPROVAL_MODE=trusted-client\n\"PRAXIS_APPROVAL_MODE\"=trusted-client\nPRAXIS_APPROVAL_MODE=trusted-client\r\nPRAXIS_JIRA_PROJECT_KEY=OK\nPRAXIS_APPROVAL_MODE=trusted-client" }));
    expect(process.env.PRAXIS_APPROVAL_MODE).toBeUndefined();
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBe("OK");
  });

  it("a symlinked .env is not read at all", () => {
    const outside = repo({ "trusted.env": "PRAXIS_APPROVAL_MODE=trusted-client\nPRAXIS_JIRA_PROJECT_KEY=LINKED" });
    const dir = repo({});
    symlinkSync(join(outside, "trusted.env"), join(dir, ".env"));
    loadPraxisDotenv(dir);
    expect(process.env.PRAXIS_APPROVAL_MODE).toBeUndefined();
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBeUndefined();
  });

  it("S2: an allowed key with path, query, JQL or injection syntax in its value is refused", () => {
    for (const bad of ["X/../../rest/api/2/myself?a=b#", "PRX OR project = SECRET", "prx", "PRX\"; DROP", "A".repeat(40), "../PRX", "PRX%2f..", "P R X"]) {
      delete process.env.PRAXIS_JIRA_PROJECT_KEY;
      loadPraxisDotenv(repo({ ".env": `PRAXIS_JIRA_PROJECT_KEY=${bad}` }));
      expect(process.env.PRAXIS_JIRA_PROJECT_KEY, bad).toBeUndefined();
    }
    for (const bad of ["customfield_1/../x", "a?b=c", "x#y"]) {
      delete process.env.PRAXIS_JIRA_STORY_POINTS_FIELD;
      loadPraxisDotenv(repo({ ".env": `PRAXIS_JIRA_STORY_POINTS_FIELD=${bad}` }));
      expect(process.env.PRAXIS_JIRA_STORY_POINTS_FIELD, bad).toBeUndefined();
    }
    delete process.env.PRAXIS_JIRA_STORY_TYPE_ID;
    loadPraxisDotenv(repo({ ".env": "PRAXIS_JIRA_STORY_TYPE_ID=10001" }));
    expect(process.env.PRAXIS_JIRA_STORY_TYPE_ID).toBe("10001");
    delete process.env.PRAXIS_JIRA_STORY_TYPE_ID;
    loadPraxisDotenv(repo({ ".env": "PRAXIS_JIRA_STORY_TYPE_ID=10001/../x" }));
    expect(process.env.PRAXIS_JIRA_STORY_TYPE_ID).toBeUndefined();
  });

  it("S3: one repository's file does not apply to another repository, or to a repository without a file", () => {
    delete process.env.PRAXIS_JIRA_PROJECT_KEY;
    loadPraxisDotenv(repo({ ".env": "PRAXIS_JIRA_PROJECT_KEY=AAA" }));
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBe("AAA");
    loadPraxisDotenv(repo({ ".env": "PRAXIS_JIRA_PROJECT_KEY=BBB" }));
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBe("BBB");
    loadPraxisDotenv(repo({}));
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBeUndefined();
    // the operator's own value is never taken back
    process.env.PRAXIS_JIRA_PROJECT_KEY = "OPS";
    loadPraxisDotenv(repo({ ".env": "PRAXIS_JIRA_PROJECT_KEY=AAA" }));
    loadPraxisDotenv(repo({}));
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBe("OPS");
  });

  it("S4: a FIFO, a device or an oversized file named .env cannot hang or slow the Runtime", () => {
    const dir = repo({});
    execFileSync("mkfifo", [join(dir, ".env")]);
    const start = Date.now();
    loadPraxisDotenv(dir);
    expect(Date.now() - start).toBeLessThan(2000);
    const big = repo({ ".env": `${"X=1\n".repeat(40_000)}PRAXIS_JIRA_PROJECT_KEY=BIG\n` });
    delete process.env.PRAXIS_JIRA_PROJECT_KEY;
    loadPraxisDotenv(big);
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBeUndefined();
  });

  it("S9: CRLF, a BOM, an export prefix, quotes and trailing comments behave the way users expect, for allowed keys only", () => {
    delete process.env.PRAXIS_JIRA_PROJECT_KEY;
    delete process.env.PRAXIS_GIT_PROVIDER;
    delete process.env.PRAXIS_WORK_PACKAGE_MAX_HOURS;
    loadPraxisDotenv(repo({ ".env": "\uFEFFexport PRAXIS_JIRA_PROJECT_KEY=PRX # the project\r\nPRAXIS_GIT_PROVIDER=\"github\"\r\nPRAXIS_WORK_PACKAGE_MAX_HOURS='8'  \r\nexport PRAXIS_APPROVAL_MODE=trusted-client\r\n" }));
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBe("PRX");
    expect(process.env.PRAXIS_GIT_PROVIDER).toBe("github");
    expect(process.env.PRAXIS_WORK_PACKAGE_MAX_HOURS).toBe("8");
    expect(process.env.PRAXIS_APPROVAL_MODE).toBeUndefined();
  });

  it("the product's own variables in .env (DATABASE_URL, API keys) are not loaded into the Runtime and are not reported", () => {
    delete process.env.DATABASE_URL;
    loadPraxisDotenv(repo({ ".env": "DATABASE_URL=postgres://x\nSTRIPE_KEY=sk_live_x\nPRAXIS_APPROVAL_MODE=trusted-client" }));
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.STRIPE_KEY).toBeUndefined();
    expect(JSON.stringify(dotenvRejectedKeys())).not.toMatch(/DATABASE_URL|STRIPE/);
  });
});
