import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withApprovalChannel, type ApprovalRequest, type AskAnswer, type UserApprovalChannel } from "@praxis/contracts";
import { projectInitApplyOp } from "./operations.js";

function repo() {
  return mkdtempSync(join(tmpdir(), "praxis-guard-"));
}

function channel(answer: AskAnswer, seen: ApprovalRequest[] = []): UserApprovalChannel {
  return {
    kind: "client-elicitation",
    async ask(request) {
      seen.push(request);
      return answer;
    },
  };
}

const log = (root: string) =>
  readFileSync(join(root, ".praxis", "approvals", "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

const strictBefore = process.env.PRAXIS_APPROVAL_STRICT;
afterEach(() => {
  if (strictBefore === undefined) delete process.env.PRAXIS_APPROVAL_STRICT;
  else process.env.PRAXIS_APPROVAL_STRICT = strictBefore;
});

describe("a protected action runs only after the user approves it", () => {
  it("without confirmation=YES nothing is asked and nothing is written", async () => {
    const root = repo();
    await expect(projectInitApplyOp({ repo: root })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(existsSync(join(root, ".project"))).toBe(false);
  });

  it("Approve in the client dialog: the action runs, and the user was shown this action", async () => {
    const root = repo();
    const seen: ApprovalRequest[] = [];
    const result = await withApprovalChannel(channel({ answer: "approve" }, seen), () => projectInitApplyOp({ repo: root, confirmation: "YES" }));
    expect(result.wrote).toBe(true);
    expect(existsSync(join(root, ".project"))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: "praxis_project_init_apply", kind: "development_action" });
    expect(seen[0]!.description).toContain("praxis_project_init_apply");
    expect(log(root).at(-1)).toMatchObject({ decision: "approved", channel: "client-elicitation", assurance: "client-ui" });
  });

  it("Reject and Dismiss: nothing is written, and the agent's confirmation=YES does not override them", async () => {
    for (const answer of ["reject", "dismiss"] as const) {
      const root = repo();
      await expect(
        withApprovalChannel(channel({ answer }), () => projectInitApplyOp({ repo: root, confirmation: "YES" })),
      ).rejects.toMatchObject({ code: "APPROVAL_REJECTED" });
      expect(existsSync(join(root, ".project"))).toBe(false);
      expect(log(root).at(-1)).toMatchObject({ decision: answer === "reject" ? "rejected" : "dismissed", assurance: "client-ui" });
    }
  });

  it("confirmation=NO is a rejection even in a client without a dialog", async () => {
    const root = repo();
    await expect(projectInitApplyOp({ repo: root, confirmation: "NO" })).rejects.toMatchObject({ code: "APPROVAL_REJECTED" });
    expect(existsSync(join(root, ".project"))).toBe(false);
  });

  it("a client without a dialog: the action runs on confirmation=YES and is recorded as unverified", async () => {
    const root = repo();
    const result = await projectInitApplyOp({ repo: root, confirmation: "YES" });
    expect(result.wrote).toBe(true);
    expect(log(root).at(-1)).toMatchObject({ decision: "approved", channel: "confirmation-flag", assurance: "unverified" });
  });

  it("strict mode refuses the fallback and writes nothing", async () => {
    process.env.PRAXIS_APPROVAL_STRICT = "1";
    const root = repo();
    await expect(projectInitApplyOp({ repo: root, confirmation: "YES" })).rejects.toMatchObject({ code: "APPROVAL_CLIENT_UI_REQUIRED" });
    expect(existsSync(join(root, ".project"))).toBe(false);
    const viaDialog = await withApprovalChannel(channel({ answer: "approve" }), () => projectInitApplyOp({ repo: root, confirmation: "YES" }));
    expect(viaDialog.wrote).toBe(true);
  });
});
