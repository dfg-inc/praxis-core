import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decisionLogPath, withApprovalChannel, type ApprovalRequest, type AskAnswer, type UserApprovalChannel } from "@praxis/contracts";
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
  readFileSync(decisionLogPath(root), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

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
    // the user is shown the exact file that will be written, not a label
    expect(seen[0]!.description).toContain(`Creates ${join(root, ".project")} with exactly this content`);
    expect(seen[0]!.description).toMatch(/requirementsFormat: user-story-gherkin/);
    expect(log(root).at(-1)).toMatchObject({ decision: "approved", channel: "client-elicitation" });
  });

  it("Reject and Dismiss: nothing is written, and the agent's confirmation=YES does not override them", async () => {
    for (const answer of ["reject", "dismiss"] as const) {
      const root = repo();
      await expect(
        withApprovalChannel(channel({ answer }), () => projectInitApplyOp({ repo: root, confirmation: "YES" })),
      ).rejects.toMatchObject({ code: "APPROVAL_REJECTED" });
      expect(existsSync(join(root, ".project"))).toBe(false);
      expect(log(root).at(-1)).toMatchObject({ decision: answer === "reject" ? "rejected" : "dismissed" });
    }
  });

  it("confirmation=NO is a rejection: recorded, nothing runs", async () => {
    const root = repo();
    await expect(projectInitApplyOp({ repo: root, confirmation: "NO" })).rejects.toMatchObject({ code: "APPROVAL_REJECTED" });
    expect(existsSync(join(root, ".project"))).toBe(false);
  });

  it("a client without a dialog: refused with the preview, nothing written, whatever the agent says", async () => {
    const root = repo();
    const error = await projectInitApplyOp({ repo: root, confirmation: "YES" }).catch((e) => e);
    expect(error).toMatchObject({ code: "APPROVAL_CLIENT_UI_REQUIRED" });
    expect(error.message).toMatch(/NOT executed/);
    expect(error.details).toMatchObject({ executed: false, preview: { action: "praxis_project_init_apply" } });
    expect(existsSync(join(root, ".project"))).toBe(false);
    expect(existsSync(join(root, ".praxis"))).toBe(false); // the journal is not in the repository
    expect(log(root).at(-1)).toMatchObject({ decision: "refused", channel: "none" });
  });
});
