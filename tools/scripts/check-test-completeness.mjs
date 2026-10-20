#!/usr/bin/env node
/**
 * Test completeness guard: a green `npm test` must mean everything that should run did run.
 *
 * It fails on anything that makes a test run look complete when it is not, unless the exception is
 * written down with a reason in test-completeness.allowlist.json:
 *
 *   no-test-script  a workspace has test files but no `test` script (so `npm test --workspaces
 *                   --if-present` silently skips it)
 *   exclude         a test script or vitest config excludes tests (--exclude, `exclude:`), or uses
 *                   --passWithNoTests
 *   skip            it/test/describe .skip/.todo/.skipIf/.runIf, xit/xdescribe, t.skip(
 *   early-return    a test returns early because a file or directory is missing instead of asserting
 *   unowned-test    a test file belongs to no workspace and no package.json script mentions it, so
 *                   nothing ever runs it
 *   only            .only: never allowlistable, it hides every other test
 *
 * An allowlist entry that no longer matches anything fails too, so exceptions cannot go stale.
 *
 *   node tools/scripts/check-test-completeness.mjs [--root=<dir>] [--allowlist=<file>] [--json]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".praxis", ".praxis-quality", "coverage", "build", "vendor"]);
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const CONFIG_FILE = /^vitest(\.[\w-]+)?\.config\.(ts|js|mjs|cjs|mts|cts)$/;

const SOURCE_RULES = [
  { kind: "only", re: /\b(?:it|test|describe)\.only\b/ },
  { kind: "skip", re: /\b(?:it|test|describe)\.(?:skip|todo|skipIf|runIf)\b|\b(?:xit|xtest|xdescribe)\s*\(|\bt\.skip\s*\(/ },
  { kind: "early-return", re: /if\s*\(\s*!\s*(?:fs\.)?existsSync\s*\([^)]*\)\s*\)\s*(?:\{\s*)?return\b/ },
];

const posix = (path) => path.split(sep).join("/");

// Text inside a string literal is not code (a test may quote `it.skip(` as a fixture). Single-line
// literals only; a multi-line template literal is not understood and can still produce a finding.
const STRING_LITERAL = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
const withoutStrings = (line) => line.replace(STRING_LITERAL, '""');

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function workspaceDirs(root) {
  const pkg = readJson(join(root, "package.json"));
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
  const dirs = new Set();
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const base = join(root, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(base, entry.name, "package.json"))) dirs.add(join(base, entry.name));
      }
    } else if (existsSync(join(root, pattern, "package.json"))) {
      dirs.add(join(root, pattern));
    }
  }
  return [...dirs].sort();
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (statSync(full).isFile()) visit(full);
  }
}

export function scan(root) {
  const findings = [];
  const roots = [root, ...workspaceDirs(root)];
  const owner = (file) =>
    roots.filter((dir) => file === dir || file.startsWith(dir + sep)).sort((a, b) => b.length - a.length)[0];
  const testFilesBy = new Map(roots.map((dir) => [dir, []]));
  const configs = [];
  walk(root, (file) => {
    if (TEST_FILE.test(file)) testFilesBy.get(owner(file))?.push(file);
    if (CONFIG_FILE.test(file.split(sep).pop())) configs.push(file);
  });

  const allScripts = roots
    .map((dir) => join(dir, "package.json"))
    .filter((path) => existsSync(path))
    .flatMap((path) => Object.values(readJson(path).scripts ?? {}).map(String))
    .join("\n");
  const rootPkg = readJson(join(root, "package.json"));
  // A root `test` script that runs every workspace does not run files that live outside the workspaces.
  for (const file of testFilesBy.get(root) ?? []) {
    const rel = posix(relative(root, file));
    if (!allScripts.includes(rel)) {
      findings.push({ kind: "unowned-test", path: rel, text: "belongs to no workspace and no script runs it" });
    }
  }
  void rootPkg;
  let testFiles = 0;
  for (const dir of roots) {
    const pkgPath = join(dir, "package.json");
    const pkg = existsSync(pkgPath) ? readJson(pkgPath) : {};
    const files = testFilesBy.get(dir) ?? [];
    testFiles += files.length;
    if (dir !== root && files.length > 0 && !pkg.scripts?.test) {
      findings.push({
        kind: "no-test-script",
        path: posix(relative(root, pkgPath)),
        text: `${files.length} test file(s) but no "test" script`,
      });
    }
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      for (const match of String(command).matchAll(/--exclude(?:=|\s+)\S+|--passWithNoTests/g)) {
        findings.push({ kind: "exclude", path: posix(relative(root, pkgPath)), text: `scripts.${name}: ${match[0]}` });
      }
    }
    for (const file of files) {
      if (dir === root && !allScripts.includes(posix(relative(root, file)))) continue; // reported as unowned-test
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        for (const rule of SOURCE_RULES) {
          if (rule.re.test(withoutStrings(line))) {
            findings.push({ kind: rule.kind, path: posix(relative(root, file)), line: index + 1, text: trimmed });
            break;
          }
        }
      });
    }
  }
  for (const file of configs) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/^\s*exclude\s*:/.test(line)) {
          findings.push({ kind: "exclude", path: posix(relative(root, file)), line: index + 1, text: line.trim() });
        }
      });
  }
  return { findings, workspaces: roots.length, testFiles };
}

export function evaluate(root, allowlist) {
  const { findings, workspaces, testFiles } = scan(root);
  const problems = [];
  const allowed = [];
  const used = new Set();
  const entries = allowlist?.entries ?? [];
  entries.forEach((entry, index) => {
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 10) {
      problems.push({ type: "bad-allowlist-entry", detail: `entry ${index} (${entry.kind} ${entry.path}) needs a reason of at least 10 characters` });
    }
  });
  for (const finding of findings) {
    if (finding.kind === "only") {
      problems.push({ type: "finding", ...finding, detail: ".only hides every other test and cannot be allowlisted" });
      continue;
    }
    const index = entries.findIndex(
      (entry) =>
        entry.kind === finding.kind &&
        entry.path === finding.path &&
        (entry.match === undefined || finding.text.includes(entry.match)) &&
        typeof entry.reason === "string" &&
        entry.reason.trim().length >= 10,
    );
    if (index >= 0) {
      used.add(index);
      allowed.push({ ...finding, reason: entries[index].reason });
    } else {
      problems.push({ type: "finding", ...finding, detail: "not allowlisted: remove it, or add an entry with a reason" });
    }
  }
  entries.forEach((entry, index) => {
    if (!used.has(index) && typeof entry.reason === "string" && entry.reason.trim().length >= 10) {
      problems.push({
        type: "stale-allowlist-entry",
        detail: `entry ${index} (${entry.kind} ${entry.path}${entry.match ? ` "${entry.match}"` : ""}) matches nothing; remove it`,
      });
    }
  });
  return { ok: problems.length === 0, workspaces, testFiles, allowed, problems };
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = resolve(option("root") ?? join(dirname(fileURLToPath(import.meta.url)), "../.."));
  const allowlistPath = resolve(option("allowlist") ?? join(root, "test-completeness.allowlist.json"));
  const allowlist = existsSync(allowlistPath) ? readJson(allowlistPath) : { entries: [] };
  const result = evaluate(root, allowlist);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const item of result.allowed) {
      console.log(`allowed  ${item.kind.padEnd(14)} ${item.path}${item.line ? `:${item.line}` : ""}  (${item.reason})`);
    }
    for (const problem of result.problems) {
      const where = problem.path ? `${problem.path}${problem.line ? `:${problem.line}` : ""}` : "";
      console.error(`FAIL     ${(problem.kind ?? problem.type).padEnd(14)} ${where}  ${problem.detail}${problem.text ? `\n         ${problem.text}` : ""}`);
    }
    console.log(
      `check-test-completeness: ${result.workspaces} package(s), ${result.testFiles} test file(s), ${result.allowed.length} justified exception(s), ${result.problems.length} problem(s)`,
    );
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
