import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalError,
  approvalModeReport,
  createUserApproval,
  hasMutationLease,
  obtainUserApproval,
  requireMutationLease,
  runApprovedMutation,
  verifyUserApproval,
  withApprovalChannel,
  type ApprovalRequest,
  type AskAnswer,
  type UserApprovalChannel,
} from "./user-approval.js";

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  action: "praxis_developer_git_commit",
  kind: "git_operation",
  summary: "Commit README.md on feature/x",
  description: "One commit with README.md",
  subject: "preview:sha256:aaaa",
  ...over,
});

const channel = (answer: AskAnswer | Error, seen: ApprovalRequest[] = []): UserApprovalChannel => ({
  kind: "client-elicitation",
  async ask(r) {
    seen.push(r);
    if (answer instanceof Error) throw answer;
    return answer;
  },
});

const strictBefore = process.env.PRAXIS_APPROVAL_STRICT;
afterEach(() => {
  if (strictBefore === undefined) delete process.env.PRAXIS_APPROVAL_STRICT;
  else process.env.PRAXIS_APPROVAL_STRICT = strictBefore;
});

describe("asking the user through the client", () => {
  it("Approve gives an approval bound to this action and subject, with client-ui assurance", async () => {
    const seen: ApprovalRequest[] = [];
    const approval = await withApprovalChannel(channel({ answer: "approve" }, seen), () => obtainUserApproval(request()));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.description).toContain("README.md");
    expect(approval.assurance).toBe("client-ui");
    expect(approval.channel).toBe("client-elicitation");
    expect(() => verifyUserApproval(approval, { action: "praxis_developer_git_commit", subject: "preview:sha256:aaaa" })).not.toThrow();
  });

  it("Reject and Dismiss stop the action, and are told apart", async () => {
    const rejected = await withApprovalChannel(channel({ answer: "reject" }), () => obtainUserApproval(request())).catch((e) => e);
    expect(rejected).toBeInstanceOf(ApprovalError);
    expect(rejected.code).toBe("APPROVAL_REJECTED");
    expect(rejected.details.rejected).toBe(true);
    const dismissed = await withApprovalChannel(channel({ answer: "dismiss" }), () => obtainUserApproval(request())).catch((e) => e);
    expect(dismissed.code).toBe("APPROVAL_REJECTED");
    expect(dismissed.details.dismissed).toBe(true);
  });

  it("a client that fails to ask is not a yes", async () => {
    const result = await withApprovalChannel(channel(new Error("client went away")), () => obtainUserApproval(request())).catch((e) => e);
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(result.message).toMatch(/client went away/);
  });

  it("the agent's confirmation=YES does not replace the dialog when a dialog exists", async () => {
    const result = await withApprovalChannel(channel({ answer: "reject" }), () => obtainUserApproval(request(), { confirmation: "YES" })).catch((e) => e);
    expect(result.code).toBe("APPROVAL_REJECTED");
  });

  it("confirmation=NO is a rejection even without a dialog", async () => {
    const result = await obtainUserApproval(request(), { confirmation: "NO" }).catch((e) => e);
    expect(result.code).toBe("APPROVAL_REJECTED");
  });
});

describe("the fallback is named for what it is", () => {
  it("without a dialog, confirmation=YES is accepted but recorded as unverified", async () => {
    const approval = await obtainUserApproval(request(), { confirmation: "YES" });
    expect(approval.assurance).toBe("unverified");
    expect(approval.channel).toBe("confirmation-flag");
    expect(approvalModeReport().mode).toBe("unverified-fallback");
  });

  it("without a dialog and without confirmation, nothing is approved", async () => {
    const result = await obtainUserApproval(request()).catch((e) => e);
    expect(result.code).toBe("APPROVAL_REQUIRED");
  });

  it("strict mode refuses the fallback, at the ask and again at verification", async () => {
    process.env.PRAXIS_APPROVAL_STRICT = "1";
    const refused = await obtainUserApproval(request(), { confirmation: "YES" }).catch((e) => e);
    expect(refused.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    delete process.env.PRAXIS_APPROVAL_STRICT;
    const unverified = await obtainUserApproval(request(), { confirmation: "YES" });
    process.env.PRAXIS_APPROVAL_STRICT = "1";
    expect(() => verifyUserApproval(unverified, { action: request().action, subject: request().subject })).toThrow(/only approvals given in the client/);
    const viaDialog = await withApprovalChannel(channel({ answer: "approve" }), () => obtainUserApproval(request()));
    expect(() => verifyUserApproval(viaDialog, { action: request().action, subject: request().subject })).not.toThrow();
    expect(approvalModeReport().strict).toBe(true);
  });
});

describe("an approval authorizes only what was shown", () => {
  const approved = () => createUserApproval({ request: request(), channel: "test" });

  it("another action, a changed subject, an old approval and a look-alike are all refused", () => {
    const approval = approved();
    expect(() => verifyUserApproval(approval, { action: "praxis_developer_git_publish", subject: request().subject })).toThrow(/not praxis_developer_git_publish/);
    expect(() => verifyUserApproval(approval, { action: request().action, subject: "preview:sha256:bbbb" })).toThrow(/content differs/);
    expect(() => verifyUserApproval(approval, { action: request().action, subject: request().subject, now: new Date(Date.now() + 11 * 60_000) })).toThrow(/too old/);
    expect(() => verifyUserApproval({ ...approval }, { action: request().action, subject: request().subject })).toThrow(/needs the user's approval/);
    expect(() => verifyUserApproval(JSON.parse(JSON.stringify(approval)), { action: request().action, subject: request().subject })).toThrow(/needs the user's approval/);
    expect(() => verifyUserApproval(undefined, { action: request().action, subject: request().subject })).toThrow(/needs the user's approval/);
  });

  it("a test approval exists only under the test harness", () => {
    const before = process.env.PRAXIS_TEST_APPROVALS;
    delete process.env.PRAXIS_TEST_APPROVALS;
    try {
      expect(() => createUserApproval({ request: request(), channel: "test" })).toThrow(/test harness/);
    } finally {
      process.env.PRAXIS_TEST_APPROVALS = before;
    }
  });
});

describe("writers run only inside an approved action", () => {
  it("a direct write has no lease; an approved one does; a forged approval cannot open one", () => {
    expect(hasMutationLease()).toBe(false);
    expect(() => requireMutationLease()).toThrow(/direct mutation is not authorized/);
    const approval = createUserApproval({ request: request(), channel: "test" });
    expect(runApprovedMutation(approval, () => (requireMutationLease(), hasMutationLease()))).toBe(true);
    expect(hasMutationLease()).toBe(false);
    expect(() => runApprovedMutation({ ...approval }, () => "wrote")).toThrow(/issued for this call/);
  });
});

describe("decisions are logged for later review", () => {
  it("approved, rejected and dismissed decisions land in .praxis/approvals/decisions.jsonl with their assurance", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-decisions-"));
    try {
      await withApprovalChannel(channel({ answer: "approve" }), () => obtainUserApproval(request(), { repo }));
      await withApprovalChannel(channel({ answer: "reject", reason: "not now" }), () => obtainUserApproval(request(), { repo })).catch(() => undefined);
      await obtainUserApproval(request(), { repo, confirmation: "YES" });
      const rows = readFileSync(join(repo, ".praxis", "approvals", "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(rows.map((r) => [r.decision, r.assurance])).toEqual([
        ["approved", "client-ui"],
        ["rejected", "client-ui"],
        ["approved", "unverified"],
      ]);
      expect(rows[1].reason).toBe("not now");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
