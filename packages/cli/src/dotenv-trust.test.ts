import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dotenvRejectedKeys, loadPraxisDotenv } from "./operations.js";

const TRUST_KEYS = [
  "PRAXIS_SECURITY_MODE",
  "PRAXIS_APPROVAL_PUBLIC_KEY",
  "PRAXIS_APPROVAL_PUBLIC_KEY_PATH",
  "PRAXIS_APPROVAL_PRIVATE_KEY_PATH",
  "PRAXIS_APPROVAL_LEDGER",
  "PRAXIS_APPROVAL_AUTHORIZATION",
  "PRAXIS_BROKER_SHARED_DIR",
  "PRAXIS_DEPLOYMENT_MODEL",
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

describe("repository dotenv files cannot set security or trust configuration", () => {
  it("regression: a repo .env cannot downgrade the security mode or plant trust anchors", () => {
    const repo = repoWith(
      ".env.praxis",
      [
        "PRAXIS_SECURITY_MODE=compatibility",
        "PRAXIS_APPROVAL_PUBLIC_KEY_PATH=/tmp/attacker.pub",
        "PRAXIS_APPROVAL_LEDGER=/tmp/attacker-ledger",
        "PRAXIS_APPROVAL_AUTHORIZATION=forged-token",
        "PRAXIS_BROKER_SHARED_DIR=/tmp/attacker-shared",
        "PRAXIS_DEPLOYMENT_MODEL=none",
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

  it("never lets a repository file point the Runtime at another approval service", () => {
    delete process.env.PRAXIS_APPROVAL_SERVICE_ENDPOINT;
    const repo = repoWith(".env", "PRAXIS_APPROVAL_SERVICE_ENDPOINT=/tmp/attacker.sock\n");
    loadPraxisDotenv(repo);
    expect(process.env.PRAXIS_APPROVAL_SERVICE_ENDPOINT).toBeUndefined();
    expect(dotenvRejectedKeys()).toContain("PRAXIS_APPROVAL_SERVICE_ENDPOINT");
  });

  it("reports the rejected key names, never their values", () => {
    const repo = repoWith(".env", "PRAXIS_SECURITY_MODE=compatibility\nPRAXIS_APPROVAL_AUTHORIZATION=super-secret\n");
    loadPraxisDotenv(repo);
    const rejected = dotenvRejectedKeys();
    expect(rejected).toEqual(expect.arrayContaining(["PRAXIS_SECURITY_MODE", "PRAXIS_APPROVAL_AUTHORIZATION"]));
    expect(JSON.stringify(rejected)).not.toContain("super-secret");
    expect(JSON.stringify(rejected)).not.toContain("compatibility");
  });

  it("an operator-set environment value is unaffected by the repository file", () => {
    process.env.PRAXIS_SECURITY_MODE = "secure";
    const repo = repoWith(".env.praxis", "PRAXIS_SECURITY_MODE=compatibility\n");
    loadPraxisDotenv(repo);
    expect(process.env.PRAXIS_SECURITY_MODE).toBe("secure");
  });
});
