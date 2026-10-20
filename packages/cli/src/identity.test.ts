import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkPackageRef } from "./identity.js";
import { developerStatusOp, workPackageShowOp, PraxisOpError } from "./operations.js";

const WORK_ITEM = "WI-TREAT-UNEXPANDED-CLAUDE--001";

function repoWith({ keyOnWp }: { keyOnWp?: string } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "identity-"));
  mkdirSync(join(repo, "work-packages", "WP-20260914-002"), { recursive: true });
  writeFileSync(
    join(repo, "work-packages", "WP-20260914-002", "manifest.json"),
    JSON.stringify({ id: "WP-20260914-002", ...(keyOnWp ? { jiraIssueKey: keyOnWp } : {}) }),
  );
  mkdirSync(join(repo, ".praxis", "workflow", "items"), { recursive: true });
  writeFileSync(join(repo, ".praxis", "workflow", "items", `${WORK_ITEM}.json`), "{}");
  return repo;
}

describe("work package identity", () => {
  it("keeps a local Work Package id local: no invented Jira key", () => {
    const r = resolveWorkPackageRef(repoWith(), "WP-20260914-002");
    expect(r).toMatchObject({ kind: "work-package-id", workPackageId: "WP-20260914-002", jiraIssueKey: null });
  });

  it("reports the Jira key a Work Package records, as its own identity", () => {
    const repo = repoWith({ keyOnWp: "PRX-7" });
    expect(resolveWorkPackageRef(repo, "WP-20260914-002").jiraIssueKey).toBe("PRX-7");
    expect(resolveWorkPackageRef(repo, "PRX-7")).toMatchObject({ kind: "jira-issue-key", workPackageId: "WP-20260914-002", jiraIssueKey: "PRX-7" });
  });

  it("recognises a Jira key that has no local Work Package", () => {
    expect(resolveWorkPackageRef(repoWith(), "PRX-99")).toMatchObject({ kind: "jira-issue-key", jiraIssueKey: "PRX-99" });
  });

  it("recognises a Work Item id and never turns it into a Jira key", () => {
    expect(resolveWorkPackageRef(repoWith(), WORK_ITEM)).toMatchObject({ kind: "work-item-id", jiraIssueKey: null });
  });

  it("calls anything else unknown", () => {
    expect(resolveWorkPackageRef(repoWith(), "hello world").kind).toBe("unknown");
    expect(resolveWorkPackageRef(repoWith(), "wp-1").kind).toBe("unknown");
  });
});

describe("developer status identity (no Jira configured)", () => {
  // The suite must never reach a real tracker, whatever the developer's shell exports.
  beforeEach(() => {
    for (const name of ["BASE_URL", "TOKEN", "PROJECT_KEY", "EMAIL"]) vi.stubEnv(`PRAXIS_JIRA_${name}`, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a Work Item id with a pointer to workItemId", async () => {
    const repo = repoWith();
    await expect(developerStatusOp({ repo, wp: WORK_ITEM })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("Work Item id"),
    });
    await expect(workPackageShowOp({ repo, wp: WORK_ITEM })).rejects.toBeInstanceOf(PraxisOpError);
  });

  it("refuses a value that is no known identity", async () => {
    await expect(developerStatusOp({ repo: repoWith(), wp: "hello world" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("returns a null jiraIssueKey for a local Work Package", async () => {
    const status = await developerStatusOp({ repo: repoWith(), wp: "WP-20260914-002" });
    expect(status.jiraIssueKey).toBeNull();
    expect(status.identity).toMatchObject({ kind: "work-package-id" });
  });

  it("returns the recorded key for a Work Package that has one, and for that key", async () => {
    const repo = repoWith({ keyOnWp: "PRX-7" });
    expect((await developerStatusOp({ repo, wp: "WP-20260914-002" })).jiraIssueKey).toBe("PRX-7");
    expect((await developerStatusOp({ repo, wp: "PRX-7" })).jiraIssueKey).toBe("PRX-7");
  });
});
