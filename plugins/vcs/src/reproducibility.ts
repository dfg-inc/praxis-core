import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runGit } from "./git-local.js";

export type ReproRun = {
  sha: string;
  ok: boolean;
  passed: number | null;
  failed: number | null;
  output: string;
};

export type ReproducibilityReport = {
  baseline: ReproRun;
  feature: ReproRun;
  blockers: string[];
  worktreeMutatedMainRepo: false;
};

function parseTestCounts(output: string): { passed: number | null; failed: number | null } {
  const pass =
    output.match(/# pass\s+(\d+)/)?.[1] ??
    output.match(/(?:^|\n)(?:ℹ\s+)?pass\s+(\d+)/)?.[1] ??
    output.match(/# tests\s+(\d+)/)?.[1];
  const fail =
    output.match(/# fail\s+(\d+)/)?.[1] ??
    output.match(/(?:^|\n)(?:ℹ\s+)?fail\s+(\d+)/)?.[1];
  return {
    passed: pass ? Number(pass) : null,
    failed: fail ? Number(fail) : null,
  };
}

function runNpmTestAtSha(repo: string, sha: string, label: string): ReproRun {
  const dir = mkdtempSync(join(tmpdir(), `praxis-repro-${label}-`));
  const add = runGit(repo, ["worktree", "add", "--detach", dir, sha]);
  if (add.status !== 0) {
    return {
      sha,
      ok: false,
      passed: null,
      failed: null,
      output: add.stderr || `git worktree add failed for ${sha}`,
    };
  }
  try {
    const test = spawnSync("npm", ["test", "--ignore-scripts"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    });
    const output = `${test.stdout}\n${test.stderr}`;
    const parsed = parseTestCounts(output);
    return {
      sha,
      ok: (test.status ?? 1) === 0,
      passed: parsed.passed,
      failed: parsed.failed,
      output: output.slice(0, 4000),
    };
  } finally {
    runGit(repo, ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

export function verifyCommittedReproducibility(
  repo: string,
  baselineSha: string,
  featureSha: string,
): ReproducibilityReport {
  const baseline = runNpmTestAtSha(repo, baselineSha, "base");
  const feature = runNpmTestAtSha(repo, featureSha, "feat");
  const blockers: string[] = [];
  if (!baseline.ok) {
    blockers.push(
      "Baseline committed tree failed npm test. Publication is blocked until the committed baseline is reproducible.",
    );
  }
  if (!feature.ok) {
    blockers.push(
      "Feature committed tree failed npm test. Uncommitted package.json / package-lock.json / .npmrc may be required. Do not silently add them; correct the delivery scope.",
    );
  }
  return { baseline, feature, blockers, worktreeMutatedMainRepo: false };
}
