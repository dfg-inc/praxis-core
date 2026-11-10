import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApprovalError,
  ApprovalNeedsInput,
  approvalModeReport,
  decisionLogPath,
  approvalsGivenInThisCall,
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

describe("asking the user through the client", () => {
  it("Approve gives an approval bound to this action and subject", async () => {
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
    expect(rejected.details).toMatchObject({ outcome: "rejected", decidedBy: "client-dialog", personVerified: false, executed: false });
    const dismissed = await withApprovalChannel(channel({ answer: "dismiss" }), () => obtainUserApproval(request())).catch((e) => e);
    // closing the dialog is not a "no": its own code, and the same compatibility flags as before
    expect(dismissed.code).toBe("APPROVAL_DISMISSED");
    expect(dismissed.details).toMatchObject({ dismissed: true, rejected: false, outcome: "dismissed", decidedBy: "client-dialog" });
    expect(dismissed.message).toMatch(/not a rejection/);
  });

  it("a client that fails to ask is not a yes, and the preview comes back", async () => {
    const result = await withApprovalChannel(channel(new Error("client went away")), () => obtainUserApproval(request())).catch((e) => e);
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(result.message).toMatch(/client went away/);
    expect(result.details.preview.summary).toBe(request().summary);
  });

  it("the agent's confirmation=YES never replaces the dialog: a reject stays a reject", async () => {
    const result = await withApprovalChannel(channel({ answer: "reject" }), () => obtainUserApproval(request(), { confirmation: "YES" })).catch((e) => e);
    expect(result.code).toBe("APPROVAL_REJECTED");
  });

  it("confirmation=NO is the agent withdrawing the request: it asks nobody and is never the user's rejection", async () => {
    const seen: ApprovalRequest[] = [];
    const result = await withApprovalChannel(channel({ answer: "approve" }, seen), () => obtainUserApproval(request(), { confirmation: "NO" })).catch((e) => e);
    expect(result.code).toBe("APPROVAL_WITHDRAWN");
    expect(result.details).toMatchObject({ outcome: "withdrawn", decidedBy: "agent", rejected: false, executed: false });
    expect(result.message).toMatch(/withdrawn by the agent/);
    expect(result.message).not.toMatch(/rejected by the user/);
    expect(seen).toHaveLength(0);
  });

  it("a client that answers by itself is the client's answer: nobody rejected anything", async () => {
    const result = await withApprovalChannel(channel({ answer: "unavailable", automatic: "decline", evidence: { latencyMs: 9, client: "claude-code 2.1.309" } }), () => obtainUserApproval(request(), { confirmation: "YES" })).catch((e) => e);
    expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(result.details).toMatchObject({ outcome: "auto-answered", decidedBy: "client", automatic: "decline", evidence: { latencyMs: 9 }, executed: false });
    expect(result.message).toMatch(/nobody rejected it/);
    expect(result.message).toMatch(/9 ms/);
  });

  it("a channel's own outcome (an open page, a timeout) is passed through with its outcome, never as a no", async () => {
    for (const [code, outcome] of [["APPROVAL_PENDING", "pending"], ["APPROVAL_TIMED_OUT", "timed-out"], ["APPROVAL_EXPIRED", "expired"]] as const) {
      const result = await withApprovalChannel(channel(new ApprovalError(code, "x", { requestId: "r1" })), () => obtainUserApproval(request())).catch((e) => e);
      expect(result.code).toBe(code);
      expect(result.details).toMatchObject({ outcome, decidedBy: "nobody", executed: false, requestId: "r1" });
    }
  });
});

describe("an approval says which channel really answered", () => {
  it("a wrapper that hands a request on is labelled with the channel that answered, and a page click ages from the click", async () => {
    const clicked = new Date(Date.now() - 60_000).toISOString();
    const wrapper: UserApprovalChannel = { kind: "trusted-client", ask: async () => ({ answer: "approve", channel: "approval-page", evidence: { requestId: "r1", decidedAt: clicked } }) };
    const approval = await withApprovalChannel(wrapper, () => obtainUserApproval(request()));
    expect([approval.channel, approval.assurance, approval.decidedAt]).toEqual(["approval-page", "approval-page", clicked]);
    // a click older than the approval's lifetime cannot be used, however it is handed over
    const stale: UserApprovalChannel = { kind: "approval-page", ask: async () => ({ answer: "approve", evidence: { decidedAt: new Date(Date.now() - 11 * 60_000).toISOString() } }) };
    const old = await withApprovalChannel(stale, () => obtainUserApproval(request()));
    expect(() => verifyUserApproval(old, { action: request().action, subject: request().subject })).toThrow(/too old/);
  });
});

describe("a client without a dialog: nothing protected runs", () => {
  it("is refused with the preview and a clear message, whatever the agent says", async () => {
    for (const confirmation of [undefined, "YES", "yes", "I confirm", "APPROVED"]) {
      const result = await obtainUserApproval(request(), { confirmation }).catch((e) => e);
      expect(result.code, String(confirmation)).toBe("APPROVAL_CLIENT_UI_REQUIRED");
      expect(result.message).toMatch(/NOT executed/);
      expect(result.message).toMatch(/not accepted as approval/);
      expect(result.details).toMatchObject({ executed: false, preview: { action: "praxis_developer_git_commit", summary: "Commit README.md on feature/x", description: "One commit with README.md" } });
    }
  });

  it("a dialog that is unavailable for this connection is handled the same way, never as a yes", async () => {
    const result = await withApprovalChannel(channel({ answer: "unavailable" }), () => obtainUserApproval(request(), { confirmation: "YES" })).catch((e) => e);
    expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
  });

  it("the mode report says plainly that protected actions are not executed", () => {
    expect(approvalModeReport().mode).toBe("no-dialog");
    expect(approvalModeReport().note).toMatch(/NOT executed/);
    expect(withApprovalChannel(channel({ answer: "approve" }), () => approvalModeReport().mode)).toBe("client-ui");
  });

  it("there is no unverified or strict mode any more", async () => {
    process.env.PRAXIS_APPROVAL_STRICT = "0";
    try {
      const result = await obtainUserApproval(request(), { confirmation: "YES" }).catch((e) => e);
      expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    } finally {
      delete process.env.PRAXIS_APPROVAL_STRICT;
    }
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

describe("decisions are journaled outside the repository", () => {
  it("approved, rejected and refused decisions land in the user's Praxis home, not in the repository", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-decisions-"));
    try {
      await withApprovalChannel(channel({ answer: "approve" }), () => obtainUserApproval(request(), { repo }));
      await withApprovalChannel(channel({ answer: "reject", reason: "not now" }), () => obtainUserApproval(request(), { repo })).catch(() => undefined);
      await obtainUserApproval(request(), { repo, confirmation: "YES" }).catch(() => undefined);
      await obtainUserApproval(request(), { repo, confirmation: "NO" }).catch(() => undefined);
      await withApprovalChannel(channel({ answer: "dismiss" }), () => obtainUserApproval(request(), { repo })).catch(() => undefined);
      await withApprovalChannel(channel({ answer: "unavailable", automatic: "decline", evidence: { latencyMs: 12 } }), () => obtainUserApproval(request(), { repo })).catch(() => undefined);
      await withApprovalChannel(channel({ answer: "approve", journaled: true }), () => obtainUserApproval(request(), { repo }));
      const path = decisionLogPath(repo);
      expect(path.startsWith(repo)).toBe(false);
      expect(existsSync(join(repo, ".praxis"))).toBe(false);
      const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      // the approval the page already journaled at the click is not written a second time
      expect(rows.map((r) => r.decision)).toEqual(["approved", "rejected", "unavailable", "withdrawn", "dismissed", "auto-answered"]);
      // the channel that answered, never "the user": Praxis cannot tell a person from automation driving that channel
      expect(rows.map((r) => r.decidedBy)).toEqual(["client-dialog", "client-dialog", "nobody", "agent", "client-dialog", "client"]);
      expect(rows.filter((r) => r.decidedBy === "client-dialog").every((r) => r.personVerified === false)).toBe(true);
      expect(rows.every((r) => r.v === 2)).toBe(true);
      expect(rows[1].reason).toBe("not now");
      expect(rows[5].evidence).toEqual({ latencyMs: 12 });
      expect(rows[0].repository).toBe(repo);
      expect(JSON.stringify(rows)).not.toMatch(/unverified/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("the result can say how each approval was obtained", () => {
  it("approvals given during a call are listed with their assurance", async () => {
    const rows = await withApprovalChannel(channel({ answer: "approve" }), async () => {
      await obtainUserApproval(request());
      return approvalsGivenInThisCall().map((a) => [a.action, a.assurance]);
    });
    expect(rows).toEqual([["praxis_developer_git_commit", "client-ui"]]);
    expect(approvalsGivenInThisCall()).toEqual([]);
  });
});

describe("a channel that needs a separate round trip", () => {
  it("unwinds with the request, before anything runs, and is neither an approval nor a refusal", async () => {
    const needs: UserApprovalChannel = {
      kind: "client-elicitation",
      async ask(r) {
        throw new ApprovalNeedsInput(r);
      },
    };
    const result = await withApprovalChannel(needs, () => obtainUserApproval(request())).catch((e) => e);
    expect(result).toBeInstanceOf(ApprovalNeedsInput);
    expect(result.request.subject).toBe(request().subject);
  });
});
