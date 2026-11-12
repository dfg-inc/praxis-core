/**
 * 0.1.0-alpha.49.3, Agent A: the repository's own test command from .project is repository code. It runs with the
 * allowlisted environment, so the Runtime's Jira token is not in its own environment (hygiene only: the child can still read
 * the Runtime's environment with ps -E; see contracts child-env.ts). Fake token only.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProjectVerification } from "../src/developer-complete.js";

const KEYS = ["PRAXIS_JIRA_TOKEN", "PRAXIS_GITHUB_TOKEN", "GH_TOKEN"] as const;
let saved: Record<string, string | undefined>;
let repo: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "praxis-a-jira-child-")));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(repo, { recursive: true, force: true });
});

describe("the repository's test command is not handed credentials", () => {
  it("a command that dumps its environment sees PATH, never a token", () => {
    process.env.PRAXIS_JIRA_TOKEN = "praxis-fake-token-jira-a1b2c3d4";
    process.env.PRAXIS_GITHUB_TOKEN = "praxis-fake-token-gh-a1b2c3d4";
    process.env.GH_TOKEN = "praxis-fake-token-ghcli-a1b2c3d4";
    writeFileSync(join(repo, "dump.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(join(repo, "env.json"))}, JSON.stringify(process.env)); console.log("# pass 1\\n# fail 0");\n`);
    writeFileSync(join(repo, ".project"), `quality:\n  test: ${JSON.stringify(`${process.execPath} dump.cjs`)}\n`);
    const result = runProjectVerification(repo);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(readFileSync(join(repo, "env.json"), "utf8")) as Record<string, string>;
    expect(env.PATH).toBe(process.env.PATH);
    expect(JSON.stringify(env)).not.toMatch(/praxis-fake-token/);
    expect(Object.keys(env).filter((k) => k.startsWith("PRAXIS_"))).toEqual([]);
  });
});
