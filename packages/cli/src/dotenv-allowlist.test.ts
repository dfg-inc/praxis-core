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

  it("only the allowlisted per-project naming settings load", () => {
    loadPraxisDotenv(repo({ ".env": lines(ALLOWED, "PRX") }));
    for (const k of ALLOWED) expect(process.env[k], k).toBe("PRX");
    for (const k of ALLOWED) expect(dotenvKeyAllowed(k)).toBe(true);
    for (const k of FORBIDDEN) expect(dotenvKeyAllowed(k), k).toBe(false);
  });

  it("priority: the operator's real environment wins over every file; among files the first one read wins", () => {
    process.env.PRAXIS_JIRA_PROJECT_KEY = "FROM_OPERATOR";
    loadPraxisDotenv(repo({ ".env.praxis": "PRAXIS_JIRA_PROJECT_KEY=FILE1\nPRAXIS_GIT_PROVIDER=github", ".env": "PRAXIS_JIRA_PROJECT_KEY=FILE2\nPRAXIS_GIT_PROVIDER=gitlab", ".env.praxis.local": "PRAXIS_GIT_PROVIDER=other" }));
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBe("FROM_OPERATOR");
    expect(process.env.PRAXIS_GIT_PROVIDER).toBe("github");
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

  it("a symlinked .env cannot pull in another file's trust settings either", () => {
    const outside = repo({ "trusted.env": "PRAXIS_APPROVAL_MODE=trusted-client\nPRAXIS_JIRA_PROJECT_KEY=LINKED" });
    const dir = repo({});
    symlinkSync(join(outside, "trusted.env"), join(dir, ".env"));
    loadPraxisDotenv(dir);
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
