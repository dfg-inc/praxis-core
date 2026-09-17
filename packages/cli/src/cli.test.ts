import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "./exit.js";
import { envelope, isCliEnvelope } from "./envelope.js";
import { helpFor } from "./help.js";
import { parseFlags, runCli } from "./run.js";

function capture(fn: () => Promise<number>) {
  const out: string[] = [];
  const err: string[] = [];
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return fn().finally(() => {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }).then((code) => ({ code, stdout: out.join(""), stderr: err.join("") }));
}

describe("public CLI help", () => {
  const topics = [
    [],
    ["doctor"],
    ["project"],
    ["jira"],
    ["ba"],
    ["architect"],
    ["work-package"],
    ["developer"],
    ["quality"],
    ["architect", "apply"],
  ];
  for (const t of topics) {
    it(`help ${t.join(" ") || "root"}`, async () => {
      const args = t.length ? [...t, "--help"] : ["--help"];
      const { code, stdout } = await capture(() => runCli(args));
      expect(code).toBe(EXIT.OK);
      expect(stdout.length).toBeGreaterThan(40);
      expect(stdout).toMatch(/USAGE|praxis/);
    });
  }

  it("json help is a valid envelope", async () => {
    const { code, stdout } = await capture(() => runCli(["--help", "--json"]));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(isCliEnvelope(parsed)).toBe(true);
    expect(parsed.data.help).toMatch(/doctor/);
  });
});

describe("CLI flags and exits", () => {
  it("parses common flags", () => {
    const f = parseFlags([
      "architect",
      "apply",
      "--epic",
      "PRX-1",
      "--repo",
      ".",
      "--confirm",
      "YES",
      "--json",
    ]);
    expect(f.json).toBe(true);
    expect(f.epic).toBe("PRX-1");
    expect(f.confirm).toBe("YES");
    expect(f.argv).toEqual(["architect", "apply"]);
  });

  it("unknown command is usage", async () => {
    const { code, stdout } = await capture(() => runCli(["not-a-command", "--json"]));
    expect(code).toBe(EXIT.USAGE);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
  });

  it("architect apply without confirm is 3", async () => {
    process.env.PRAXIS_SKIP_DOTENV = "1";
    const { code, stdout } = await capture(() =>
      runCli(["architect", "apply", "--epic", "PRX-1", "--json"]),
    );
    expect(code).toBe(EXIT.CONFIRM);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]).toMatch(/confirm/);
  });

  it("missing jira config is usage/config", async () => {
    process.env.PRAXIS_SKIP_DOTENV = "1";
    delete process.env.PRAXIS_JIRA_TOKEN;
    delete process.env.PRAXIS_JIRA_BASE_URL;
    delete process.env.PRAXIS_JIRA_PROJECT_KEY;
    const { code, stdout } = await capture(() =>
      runCli(["jira", "status", "--epic", "PRX-1", "--json"]),
    );
    expect(code).toBe(EXIT.USAGE);
    expect(JSON.parse(stdout).ok).toBe(false);
  });

  it("project init --infer previews without write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-cli-"));
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "x", scripts: { test: "node --test" } }, null, 2)}\n`,
    );
    const { code, stdout } = await capture(() =>
      runCli(["project", "init", "--infer", "--repo", dir, "--json"]),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.wrote).toBe(false);
    expect(parsed.data.yaml).toMatch(/npm test/);
  });

  it("project init --infer --confirm YES writes .project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-cli-"));
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "x", scripts: { test: "node --test" } }, null, 2)}\n`,
    );
    const { code, stdout } = await capture(() =>
      runCli([
        "project",
        "init",
        "--infer",
        "--confirm",
        "YES",
        "--repo",
        dir,
        "--json",
      ]),
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout).data.wrote).toBe(true);
    const again = await capture(() =>
      runCli(["project", "status", "--repo", dir, "--json"]),
    );
    expect(JSON.parse(again.stdout).data.status.status).toBe("loaded");
  });

  it("version --json envelope", async () => {
    const { code, stdout } = await capture(() => runCli(["--version", "--json"]));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(isCliEnvelope(parsed)).toBe(true);
    expect(parsed.data.version).toMatch(/0\.1\.0/);
  });
});

describe("envelope contract", () => {
  it("has stable fields", () => {
    const e = envelope({
      ok: true,
      command: "architect.preview",
      version: "0.1.0-alpha.26",
      data: { plan: [] },
    });
    expect(e.contract).toBe("praxis.cli.envelope");
    expect(e.warnings).toEqual([]);
    expect(e.errors).toEqual([]);
  });
});

afterEach(() => {
  process.env.PRAXIS_SKIP_DOTENV = "1";
});
