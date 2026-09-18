#!/usr/bin/env node
/**
 * Praxis monorepo SemVer release CLI.
 *
 *   node tools/scripts/release-version.mjs <version>
 *   node tools/scripts/release-version.mjs <version> --dry-run
 *   node tools/scripts/release-version.mjs --check
 *
 * npm:
 *   npm run release:version -- 0.1.0-alpha.2
 *   npm run release:dry -- 0.1.0-alpha.2
 *   npm run version:check
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyVersionToFile,
  checkVersionConsistency,
  discoverVersionFiles,
  isValidSemVer,
  readJson,
  repoRootFrom,
  syncAllVersions,
  syncInternalWorkspaceDeps,
} from "./release-lib.mjs";

const root = repoRootFrom(import.meta.url);
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const checkOnly = args.includes("--check");
const versionArg = args.find((a) => !a.startsWith("--"));

function fail(msg, code = 1) {
  console.error(`release:error: ${msg}`);
  process.exit(code);
}

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, {
    cwd: root,
    shell: true,
    stdio: "inherit",
    encoding: "utf8",
  });
  return { ok: (r.status ?? 1) === 0, status: r.status ?? 1 };
}

function git(argv, opts = {}) {
  const r = spawnSync("git", argv, {
    cwd: root,
    encoding: "utf8",
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
  });
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

function assertGitRepo() {
  const r = git(["rev-parse", "--is-inside-work-tree"]);
  if (!r.ok || r.stdout !== "true") fail("not inside a git work tree");
}

function currentBranch() {
  const r = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!r.ok) fail("detached HEAD — refuse release (checkout a branch first)");
  return r.stdout;
}

function assertCleanTree() {
  const r = git(["status", "--porcelain"]);
  if (!r.ok) fail("git status failed");
  if (r.stdout) fail(`working tree is dirty:\n${r.stdout}`);
}

function tagExistsLocal(tag) {
  return git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).ok;
}

function tagExistsRemote(tag) {
  const r = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  if (!r.ok) {
    console.warn(
      "release:warn: could not query origin tags (continuing with local check only)",
    );
    return false;
  }
  return r.stdout.length > 0;
}

function previousVersion() {
  return readJson(join(root, "package.json")).version;
}

function rollbackVersionFiles(files) {
  console.error("release: rolling back version file changes…");
  const unique = [...new Set([...files, "package-lock.json"])].filter((f) =>
    existsSync(join(root, f)),
  );
  if (unique.length === 0) return;
  const r = git(["checkout", "--", ...unique]);
  if (!r.ok) {
    console.error(
      `release:error: rollback failed — restore manually:\n  git checkout -- ${unique.join(" ")}`,
    );
  } else {
    console.error(`release: rolled back: ${unique.join(", ")}`);
  }
}

function ensureLockfileVersion(version, touched) {
  const lockPath = join(root, "package-lock.json");
  if (!existsSync(lockPath)) return;
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  let changed = false;
  if (lock.version !== version) {
    lock.version = version;
    changed = true;
  }
  if (lock.packages?.[""] && lock.packages[""].version !== version) {
    lock.packages[""].version = version;
    changed = true;
  }
  if (changed) {
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
    if (!touched.includes("package-lock.json")) touched.push("package-lock.json");
  }
}

function printPlan(version, branch, prev, planned) {
  console.log(`
=== Praxis release plan ===
Mode:           ${dryRun ? "DRY-RUN" : "LIVE"}
Branch:         ${branch}
Previous:       ${prev}
New version:    ${version}
Tag:            v${version}
Files to sync:
${planned.map((f) => `  - ${f}`).join("\n") || "  (none)"}

Checks:
  1. SemVer + clean tree + branch + tag absence
  2. sync package/manifest versions + internal @praxis/* deps → "*"
  3. npm run build
  4. npm run verify
  5. npm run smoke
  6. npm run release:mirror
  7. commit chore(release): v${version}
  8. annotated tag v${version}
  9. git push origin ${branch} && git push origin v${version}
`);
}

function cmdCheck() {
  assertGitRepo();
  const report = checkVersionConsistency(root);
  const expectedTag = `v${report.expected}`;
  const localTag = tagExistsLocal(expectedTag);
  let remoteTag = false;
  try {
    remoteTag = tagExistsRemote(expectedTag);
  } catch {
    remoteTag = false;
  }
  const tagOk = localTag;
  const ok = report.ok && tagOk;
  console.log(
    JSON.stringify(
      {
        ok,
        expected: report.expected,
        internalDepPolicy: report.internalDeps?.range ?? "*",
        tag: {
          name: expectedTag,
          local: localTag,
          origin: remoteTag,
          note: tagOk
            ? "local tag matches root version"
            : `missing local tag ${expectedTag} (create via release:version)`,
        },
        files: report.files.length,
        internalDeps: report.internalDeps?.refs?.length ?? 0,
        mismatches: report.mismatches,
      },
      null,
      2,
    ),
  );
  if (!report.ok) {
    console.error(
      `version:check FAILED — ${report.mismatches.length} mismatch(es) vs root ${report.expected} / "*" internal-dep policy`,
    );
  }
  if (!tagOk) {
    console.error(
      `version:check FAILED — local git tag ${expectedTag} not found`,
    );
  }
  if (!ok) process.exit(1);
  console.log(
    `version:check PASS — ${report.files.length} files + ${report.internalDeps?.refs?.length ?? 0} internal deps + tag ${expectedTag}`,
  );
}

function cmdRelease(version) {
  if (!version) fail("usage: release-version <semver> [--dry-run]");
  if (!isValidSemVer(version)) fail(`invalid SemVer: ${version}`);

  assertGitRepo();
  const branch = currentBranch();
  if (dryRun) {
    const dirty = git(["status", "--porcelain"]);
    if (dirty.stdout) {
      console.warn(
        "release:warn: working tree is dirty (allowed for --dry-run only):\n" +
          dirty.stdout,
      );
    }
  } else {
    assertCleanTree();
  }

  const tag = `v${version}`;
  if (tagExistsLocal(tag)) fail(`tag already exists locally: ${tag}`);
  if (tagExistsRemote(tag)) fail(`tag already exists on origin: ${tag}`);

  const prev = previousVersion();
  const { changed } = syncAllVersions(root, version, { dryRun: true });
  const planned = [
    ...new Set(["package.json", "package-lock.json", ...changed]),
  ];
  printPlan(version, branch, prev, planned);

  if (dryRun) {
    console.log("DRY-RUN complete — no files changed, no commit/tag/push.");
    process.exit(0);
  }

  const touched = [];
  const npmVer = run(`npm version ${version} --no-git-tag-version`);
  if (!npmVer.ok) fail("npm version failed");
  touched.push("package.json", "package-lock.json");

  for (const rel of discoverVersionFiles(root)) {
    if (rel === "package.json") continue;
    if (applyVersionToFile(root, rel, version)) touched.push(rel);
  }
  const depSync = syncInternalWorkspaceDeps(root, { dryRun: false });
  for (const rel of depSync.changed) {
    if (!touched.includes(rel)) touched.push(rel);
  }
  ensureLockfileVersion(version, touched);

  for (const step of [
    "npm run build",
    `node tools/scripts/sync-claude-plugins.mjs --version ${version}`,
    `node tools/scripts/sync-claude-extension.mjs --version ${version}`,
    "npm run verify",
    "npm run smoke",
    "npm run release:mirror",
    "npm run plugins:validate -- --root dist/release-mirror/plugins",
  ]) {
    const r = run(step);
    if (!r.ok) {
      rollbackVersionFiles(touched);
      fail(`verification failed at: ${step}`);
    }
  }

  // Drop generated mirror from index if somehow added
  git(["reset", "HEAD", "--", "dist"], { stdio: "ignore" });

  const addList = [...new Set([...touched, "claude-plugins", "claude-extensions"])].filter((f) =>
    existsSync(join(root, f)),
  );
  const add = git(["add", "--", ...addList]);
  if (!add.ok) {
    rollbackVersionFiles(touched);
    fail(`git add failed: ${add.stderr}`);
  }

  const commit = spawnSync(
    "git",
    ["commit", "-m", `chore(release): v${version}`],
    { cwd: root, stdio: "inherit" },
  );
  if ((commit.status ?? 1) !== 0) {
    rollbackVersionFiles(touched);
    fail("git commit failed");
  }

  const head = git(["rev-parse", "--short", "HEAD"]).stdout;
  const tagCreate = git(["tag", "-a", tag, "-m", `Praxis v${version}`]);
  if (!tagCreate.ok) {
    fail(
      `git tag failed after commit ${head}. Create manually:\n  git tag -a ${tag} -m "Praxis v${version}"`,
    );
  }

  console.log(`
=== Release ready ===
Branch:           ${branch}
Previous version: ${prev}
New version:      ${version}
Commit:           ${head}
Tag:              ${tag}
Verification:     PASS
`);

  const pushBranch = spawnSync("git", ["push", "origin", branch], {
    cwd: root,
    stdio: "inherit",
  });
  if ((pushBranch.status ?? 1) !== 0) {
    fail(
      `git push origin ${branch} failed. Local commit+tag exist. Retry:\n  git push origin ${branch} && git push origin ${tag}`,
    );
  }

  const pushTag = spawnSync("git", ["push", "origin", tag], {
    cwd: root,
    stdio: "inherit",
  });
  if ((pushTag.status ?? 1) !== 0) {
    console.error(`
release:error: commit pushed but tag push failed.
Recovery (do NOT force-push):
  git push origin ${tag}
`);
    process.exit(1);
  }

  console.log(`release: SUCCESS v${version}`);
}

if (checkOnly) {
  cmdCheck();
} else {
  cmdRelease(versionArg);
}
