import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluate } from "./check-test-completeness.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-test-completeness.mjs");

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "praxis-tcg-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return root;
}

const rootPkg = (extra = {}) => ({
  name: "fixture",
  private: true,
  workspaces: ["packages/*"],
  scripts: { test: "npm run test --workspaces --if-present" },
  ...extra,
});
const pkg = (scripts) => ({ name: "pkg", scripts });
const kinds = (result) => result.problems.filter((p) => p.type === "finding").map((p) => p.kind).sort();

describe("check-test-completeness", () => {
  it("passes a repository whose workspaces all run their tests", () => {
    const root = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "packages/a/src/a.test.ts": 'import { it } from "vitest";\nit("works", () => {});\n',
    });
    expect(evaluate(root, { entries: [] })).toMatchObject({ ok: true, testFiles: 1, problems: [] });
  });

  it("regression: a workspace with tests but no test script is flagged, not silently skipped", () => {
    // `npm test --workspaces --if-present` skips such a workspace and still exits 0.
    const root = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ build: "tsc" }),
      "packages/a/src/a.test.ts": 'it("never runs", () => {});\n',
    });
    const result = evaluate(root, { entries: [] });
    expect(kinds(result)).toEqual(["no-test-script"]);
    expect(result.problems[0].path).toBe("packages/a/package.json");
  });

  it("flags excluded tests and passWithNoTests in scripts and vitest config", () => {
    const root = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run --exclude src/slow.test.ts --passWithNoTests" }),
      "packages/a/vitest.config.ts": "export default { test: {\n  exclude: ['src/b.test.ts'],\n} };\n",
      "packages/a/src/slow.test.ts": 'it("x", () => {});\n',
    });
    expect(kinds(evaluate(root, { entries: [] }))).toEqual(["exclude", "exclude", "exclude"]);
  });

  it("flags skip, todo, conditional skips and early returns on a missing path", () => {
    const root = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "packages/a/src/a.test.ts": [
        'import { existsSync } from "node:fs";',
        'it.skip("a", () => {});',
        'it.todo("b");',
        'it.skipIf(process.platform === "win32")("c", () => {});',
        'it("d", () => {',
        "  if (!existsSync(dir)) return;",
        "});",
        "// it.skip('commented out is ignored')",
      ].join("\n"),
    });
    expect(kinds(evaluate(root, { entries: [] }))).toEqual(["early-return", "skip", "skip", "skip"]);
  });

  it("ignores skip-like text that only appears inside string literals", () => {
    const root = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "packages/a/src/a.test.ts": [
        "const fixture = 'it.skip(\"x\", () => {})';",
        'const other = "if (!existsSync(p)) return;";',
        'it("describes it.only and .skipIf in its title", () => {});',
      ].join("\n"),
    });
    expect(evaluate(root, { entries: [] }).ok).toBe(true);
  });

  it(".only can never be allowlisted", () => {
    const root = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "packages/a/src/a.test.ts": 'it.only("focus", () => {});\n',
    });
    const entries = [{ kind: "only", path: "packages/a/src/a.test.ts", reason: "I really want this to be allowed" }];
    const result = evaluate(root, { entries });
    expect(kinds(result)).toEqual(["only"]);
    expect(result.problems.some((p) => p.type === "stale-allowlist-entry")).toBe(true);
  });

  it("flags a test file that belongs to no workspace and that no script runs", () => {
    const root = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "tools/security/denial.test.mjs": "process.exit(0);\n",
    });
    expect(kinds(evaluate(root, { entries: [] }))).toEqual(["unowned-test"]);
    const wired = repo({
      "package.json": rootPkg({ scripts: { test: "x", "test:security": "node tools/security/denial.test.mjs" } }),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "tools/security/denial.test.mjs": "process.exit(0);\n",
    });
    expect(evaluate(wired, { entries: [] }).ok).toBe(true);
  });

  it("an allowlisted exception passes and is reported with its reason", () => {
    const root = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "packages/a/src/a.test.ts": 'it.skipIf(!service)("needs the service", () => {});\n',
    });
    const entries = [
      { kind: "skip", path: "packages/a/src/a.test.ts", match: "needs the service", reason: "Needs the service from another repository." },
    ];
    const result = evaluate(root, { entries });
    expect(result.ok).toBe(true);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0].reason).toMatch(/another repository/);
  });

  it("an allowlist entry without a real reason does not excuse anything", () => {
    const root = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "packages/a/src/a.test.ts": 'it.skip("x", () => {});\n',
    });
    const result = evaluate(root, { entries: [{ kind: "skip", path: "packages/a/src/a.test.ts", reason: "todo" }] });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.type)).toEqual(expect.arrayContaining(["finding", "bad-allowlist-entry"]));
  });

  it("a stale allowlist entry fails so exceptions cannot outlive the thing they excuse", () => {
    const root = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "packages/a/src/a.test.ts": 'it("fine", () => {});\n',
    });
    const entries = [{ kind: "skip", path: "packages/a/src/a.test.ts", reason: "Used to skip on windows." }];
    const result = evaluate(root, { entries });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.type)).toEqual(["stale-allowlist-entry"]);
  });

  it("the CLI exits 1 with file, line and reason on problems and 0 when clean", () => {
    const bad = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "packages/a/src/a.test.ts": 'it.skip("x", () => {});\n',
    });
    const failed = spawnSync(process.execPath, [script, `--root=${bad}`], { encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/FAIL\s+skip\s+packages\/a\/src\/a\.test\.ts:1\s+not allowlisted/);
    const good = repo({
      "package.json": rootPkg(),
      "packages/a/package.json": pkg({ test: "vitest run" }),
      "packages/a/src/a.test.ts": 'it("x", () => {});\n',
    });
    const ok = spawnSync(process.execPath, [script, `--root=${good}`], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/0 problem\(s\)/);
  });
});
