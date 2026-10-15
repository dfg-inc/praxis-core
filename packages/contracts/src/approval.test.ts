import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyBrokerGrant,
  authorizeOperation,
  proposePlan,
  rejectSelfApproval,
  requestHumanApproval,
  revisePlan,
  signBrokerGrant,
  transitionApproval,
  type ApprovalDialog,
  type ApprovalPlan,
} from "./approval.js";
import { WorkflowError } from "./workflow.js";

const key = randomBytes(32);

function sample(): ApprovalPlan {
  return proposePlan({
    planId: "plan-1",
    role: "developer",
    provider: "jira",
    instanceId: "https://sdlc.example",
    workItemIds: ["WI-1"],
    repositories: ["backend"],
    operations: ["repository_edit"],
    inScope: ["edit src/counter.js"],
    outOfScope: ["git push"],
    assumptions: [],
    risks: [],
  });
}

function dialog(answer: "approve" | "reject" | "unavailable"): ApprovalDialog {
  return { confirm: async () => answer };
}

function expectCode(run: () => void, code: string) {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("trusted approval", () => {
  it("refuses to treat confirmation=YES as approval", () => {
    const plan = sample();
    expect(() => rejectSelfApproval({ confirmation: "YES", plan })).toThrow(WorkflowError);
    expect(() => transitionApproval(plan, "APPROVED")).toThrow(/host dialog grant/);
    expect(plan.state).toBe("AWAITING_APPROVAL");
  });

  it("approves only after a host dialog grant", async () => {
    const plan = sample();
    const approved = await requestHumanApproval(plan, key, dialog("approve"), new Date("2026-10-15T12:00:00.000Z"));
    expect(approved.state).toBe("APPROVED");
    expect(approved.approvedAt).toBe("2026-10-15T12:00:00.000Z");
    expect(() => authorizeOperation(approved, "repository_edit", { workItemId: "WI-1", repository: "backend" }, new Date("2026-10-15T13:00:00.000Z"))).not.toThrow();
  });

  it("blocks a rejected dialog, a missing dialog, a bad mac, and an expired grant", async () => {
    const plan = sample();
    const rejected = await requestHumanApproval(plan, key, dialog("reject"), new Date("2026-10-15T12:00:00.000Z"));
    expect(rejected.state).toBe("REJECTED");
    expect(() => authorizeOperation(rejected, "repository_edit", { workItemId: "WI-1" })).toThrow(WorkflowError);
    try {
      authorizeOperation(rejected, "repository_edit", { workItemId: "WI-1" });
    } catch (error) {
      expect(error).toMatchObject({ code: "APPROVAL_REJECTED" });
    }
    await expect(requestHumanApproval(plan, key, dialog("unavailable"), new Date("2026-10-15T12:00:00.000Z"))).rejects.toMatchObject({
      code: "APPROVAL_DIALOG_UNAVAILABLE",
    });

    const grant = signBrokerGrant(plan, key, "2026-10-15T12:00:00.000Z");
    const forged = { ...grant, mac: createHash("sha256").update("YES").digest("hex") };
    expectCode(() => applyBrokerGrant(plan, forged, key, new Date("2026-10-15T12:00:00.000Z")), "APPROVAL_GRANT_INVALID");
    expectCode(() => applyBrokerGrant(plan, grant, randomBytes(32), new Date("2026-10-15T12:00:00.000Z")), "APPROVAL_GRANT_INVALID");
    expectCode(() => applyBrokerGrant(plan, grant, key, new Date("2026-10-16T12:00:01.000Z")), "APPROVAL_EXPIRED");
  });

  it("invalidates approval when the scope changes and separates publication", async () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const approved = await requestHumanApproval(sample(), key, dialog("approve"), now);
    const revised = revisePlan(approved, { operations: ["repository_edit", "external_record_update"], workItemIds: ["WI-1", "WI-2"] });
    expect(revised.state).toBe("AWAITING_APPROVAL");
    expect(revised.fingerprint).not.toBe(approved.fingerprint);
    expect(revised.version).toBe(2);
    try {
      authorizeOperation(revised, "repository_edit", { workItemId: "WI-1" }, now);
      throw new Error("expected authorizeOperation to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "APPROVAL_REQUIRED" });
    }
    expect(() => applyBrokerGrant(revised, signBrokerGrant(approved, key, now.toISOString()), key, now)).toThrow(WorkflowError);
    try {
      applyBrokerGrant(revised, signBrokerGrant(approved, key, now.toISOString()), key, now);
    } catch (error) {
      expect(error).toMatchObject({ code: "APPROVAL_FINGERPRINT_MISMATCH" });
    }

    expectCode(() => authorizeOperation(approved, "git_push", { repository: "backend" }, now), "APPROVAL_SCOPE_SEPARATE");
    expectCode(() => authorizeOperation(approved, "repository_edit", { repository: "frontend" }, now), "APPROVAL_SCOPE_MISMATCH");
    expectCode(() => authorizeOperation(approved, "repository_edit", { workItemId: "WI-9" }, now), "APPROVAL_SCOPE_MISMATCH");
  });
});

describe("approval hook", () => {
  const hook = join(dirname(fileURLToPath(import.meta.url)), "../../../tools/hooks/praxis-approval-guard.mjs");

  function run(tool: string, input: Record<string, unknown>) {
    return spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input }),
      encoding: "utf8",
    });
  }

  it("denies self-approval tools and writes into the approval store", () => {
    const approve = run("praxis_plan_approve", { confirmation: "YES", planId: "plan-1" });
    expect(approve.status).toBe(0);
    expect(approve.stdout).toContain("deny");
    expect(approve.stdout).toContain("APPROVAL_SELF_GRANT_FORBIDDEN");

    const write = run("Write", { file_path: "/Users/me/.praxis/approvals/plan-1.json", content: "{\"state\":\"APPROVED\"}" });
    expect(write.stdout).toContain("deny");

    const bash = run("Bash", { command: "osascript -e 'click button \"Approve\"'" });
    expect(bash.stdout).toContain("deny");
  });

  it("does not deny an ordinary read", () => {
    const read = run("Read", { file_path: "/work/src/counter.js" });
    expect(read.stdout).not.toContain("deny");
  });

  it("asks the host to show a protected mutation and denies alternate store writes", () => {
    const edit = run("Edit", { file_path: "/repo/.praxis/approvals/plan-1.json" });
    expect(edit.stdout).toContain("deny");
    const multi = run("MultiEdit", { edits: [{ file_path: "/repo/.praxis/approvals/plan-1.json" }] });
    expect(multi.stdout).toContain("deny");
    const python = run("Bash", { command: "python -c 'open(\".praxis/approvals/plan-1.json\",\"w\").write(\"x\")'" });
    expect(python.stdout).toContain("deny");
    const secret = run("Bash", { command: "printenv PRAXIS_APPROVAL_KEY" });
    expect(secret.stdout).toContain("deny");
    const ask = run("praxis_ba_apply", { confirmation: "YES", repo: "/tmp/none" });
    expect(ask.stdout).toContain("\"ask\"");
    expect(ask.stdout).toContain("fail closed");
  });
});
