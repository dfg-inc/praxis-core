import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dotenvRejectedKeys, loadPraxisDotenv } from "./operations.js";

const TRUST_KEYS = [
  "PRAXIS_APPROVAL_FORGED",
  "PRAXIS_TEST_APPROVALS",
  "PRAXIS_APPROVAL_MODE",
  "PRAXIS_STATE_HOME",
  "PRAXIS_ALLOW_DOCKER_SOCKET",
  "PRAXIS_FIXTURE_EXECUTION",
  "PRAXIS_JIRA_PROJECT_KEY",
  "PRAXIS_GITLAB_BASE_URL",
];

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(TRUST_KEYS.map((k) => [k, process.env[k]]));
  for (const k of TRUST_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of TRUST_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function repoWith(file: string, body: string): string {
  const repo = mkdtempSync(join(tmpdir(), "praxis-dotenv-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, file), body);
  return repo;
}

describe("repository dotenv files cannot set approval or trust configuration", () => {
  it("regression: a repo .env cannot relax the approval policy or switch on test approvals", () => {
    const repo = repoWith(
      ".env.praxis",
      [
        "PRAXIS_APPROVAL_FORGED=1",
        "PRAXIS_TEST_APPROVALS=1",
        "PRAXIS_APPROVAL_MODE=trusted-client",
        "PRAXIS_STATE_HOME=/tmp/elsewhere",
        "PRAXIS_ALLOW_DOCKER_SOCKET=1",
        "PRAXIS_FIXTURE_EXECUTION=1",
        "PRAXIS_JIRA_PROJECT_KEY=PRX",
      ].join("\n"),
    );
    loadPraxisDotenv(repo);
    for (const key of TRUST_KEYS.filter((k) => k !== "PRAXIS_JIRA_PROJECT_KEY" && k !== "PRAXIS_GITLAB_BASE_URL")) {
      expect(process.env[key], key).toBeUndefined();
    }
    // Ordinary configuration still loads.
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBe("PRX");
  });

  it("reports the rejected key names, never their values", () => {
    const repo = repoWith(".env", "PRAXIS_APPROVAL_FORGED=1\nPRAXIS_TEST_APPROVALS=super-secret\n");
    loadPraxisDotenv(repo);
    const rejected = dotenvRejectedKeys();
    expect(rejected).toEqual(expect.arrayContaining(["PRAXIS_APPROVAL_FORGED", "PRAXIS_TEST_APPROVALS"]));
    expect(JSON.stringify(rejected)).not.toContain("super-secret");
  });

  it("an operator-set environment value is unaffected by the repository file", () => {
    process.env.PRAXIS_APPROVAL_FORGED = "1";
    const repo = repoWith(".env.praxis", "PRAXIS_APPROVAL_FORGED=1\n");
    loadPraxisDotenv(repo);
    expect(process.env.PRAXIS_APPROVAL_FORGED).toBe("1");
  });
});

