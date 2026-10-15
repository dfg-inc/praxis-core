import { describe, expect, it } from "vitest";
import { buildActionPlan, renderActionPlanForHuman } from "./action-plan.js";

describe("action plan", () => {
  it("fingerprints the exact scope and renders for a human", () => {
    const now = new Date();
    const plan = buildActionPlan({
      planId: "plan-arch-1",
      role: "architect",
      decisionKind: "architecture_decision",
      summary: "Approve DEC-001 through DEC-011 only",
      provider: "local",
      instanceId: "local",
      operations: ["external_record_update"],
      workItemIds: [],
      storyIds: [],
      decisionIds: Array.from({ length: 11 }, (_, i) => `DEC-${String(i + 1).padStart(3, "0")}`),
      repositories: [],
      actions: [
        {
          action: "record-decision",
          description: "Confirm architectural decisions",
          targets: ["DEC-001"],
        },
      ],
      risks: ["Does not confirm Stories"],
      sideEffects: ["decision.confirmed=true"],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    expect(plan.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.decisionKind).toBe("architecture_decision");
    const text = renderActionPlanForHuman(plan);
    expect(text).toContain("architecture_decision");
    expect(text).toContain("Does not confirm Stories");
    expect(text).toContain(plan.fingerprint);
  });
});
