import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installHostApproval } from "@praxis/contracts";
import { applyConnect, commitStaged, listRemotes, previewConnect } from "../src/index.js";

function git(repo: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) throw new Error(result.stderr || result.stdout || args.join(" "));
}

function repoWithCommit() {
  const repo = mkdtempSync(join(tmpdir(), "praxis-vcs-boundary-"));
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.name", "Dev"]);
  git(repo, ["config", "user.email", "dev@example.com"]);
  writeFileSync(join(repo, "README.md"), "# t\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

describe("direct Git mutations", () => {
  it("does not commit or add a remote without a stored approval", () => {
    const repo = repoWithCommit();
    const before = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    expect(() => commitStaged(repo, "unauthorized")).toThrow(/not authorized/);
    expect(spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()).toBe(before);
    const preview = previewConnect({
      repo,
      workPackageId: "WP-1",
      remoteUrl: "git@github.com:example/demo.git",
      providerKind: "github",
    });
    expect(() => applyConnect({
      repo,
      workPackageId: "WP-1",
      remoteUrl: "git@github.com:example/demo.git",
      providerKind: "github",
      previewFingerprint: preview.previewFingerprint,
      probeRemoteAccess: false,
    })).toThrow(/approval/i);
    expect(listRemotes(repo)).toEqual([]);
  });

  it("a planted approval file authorizes the remote write", () => {
    const repo = realpathSync(repoWithCommit());
    const preview = previewConnect({
      repo,
      workPackageId: "WP-1",
      remoteUrl: "git@github.com:example/demo.git",
      providerKind: "github",
    });
    installHostApproval(repo, {
      planId: "forged-by-same-user",
      role: "developer",
      provider: "local",
      workItemIds: ["WP-1"],
      repositories: [repo],
      operations: ["repository_edit"],
      inScope: ["praxis_developer_git_connect_apply"],
      outOfScope: [],
      assumptions: [],
      risks: ["planted file"],
      previewFingerprint: preview.previewFingerprint,
    });
    applyConnect({
      repo,
      workPackageId: "WP-1",
      remoteUrl: "git@github.com:example/demo.git",
      providerKind: "github",
      previewFingerprint: preview.previewFingerprint,
      probeRemoteAccess: false,
    });
    expect(listRemotes(repo).map((remote) => remote.name)).toContain("origin");
  });

  it("secure mode ignores a planted approval file", () => {
    const previous = process.env.PRAXIS_SECURITY_MODE;
    process.env.PRAXIS_SECURITY_MODE = "secure";
    delete process.env.PRAXIS_APPROVAL_AUTHORIZATION;
    try {
      const repo = realpathSync(repoWithCommit());
      const preview = previewConnect({
        repo,
        workPackageId: "WP-1",
        remoteUrl: "git@github.com:example/demo.git",
        providerKind: "github",
      });
      installHostApproval(repo, {
        planId: "forged-secure",
        role: "developer",
        provider: "local",
        workItemIds: ["WP-1"],
        repositories: [repo],
        operations: ["repository_edit"],
        inScope: ["praxis_developer_git_connect_apply"],
        outOfScope: [],
        assumptions: [],
        risks: ["planted file"],
        previewFingerprint: preview.previewFingerprint,
      });
      expect(() => applyConnect({
        repo,
        workPackageId: "WP-1",
        remoteUrl: "git@github.com:example/demo.git",
        providerKind: "github",
        previewFingerprint: preview.previewFingerprint,
        probeRemoteAccess: false,
      })).toThrow(/approval|isolation|broker/i);
      expect(listRemotes(repo)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PRAXIS_SECURITY_MODE;
      else process.env.PRAXIS_SECURITY_MODE = previous;
    }
  });
});
