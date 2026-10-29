import { describe, expect, it } from "vitest";
import { acceptanceStatus, applyWorkflowCommand, currentFingerprint, phaseGates, storyPlanFingerprint, WorkflowStateSchema, type WorkflowState } from "./index.js";

const NOW = new Date("2026-10-28T10:00:00.000Z");
const apply = (s: WorkflowState | null, c: Record<string, unknown>) => applyWorkflowCommand(s, c, { now: NOW, channel: { via: "html-review" } });
const ok = (s: WorkflowState, c: Record<string, unknown>) => apply(s, c).state;

function guidedPlan(): WorkflowState {
  let s = apply(null, { action: "open", projectId: "orders", title: "Orders", request: "Orders", mode: "guided" }).state;
  s = ok(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers filter orders", acceptanceCriteria: ["Filter works", "Reset works"] });
  s = ok(s, { action: "accept-requirements", via: "html-review" });
  s = ok(s, { action: "set-story-plan", entries: [
    { id: "US-ORD-001", title: "Filter", implementation: "A status filter", userGets: "filtered list", requirementIds: ["REQ-ORD-001"], capabilities: ["filter", "view", "states"] },
    { id: "US-ORD-002", title: "Reset", implementation: "A reset button", userGets: "back to all", requirementIds: ["REQ-ORD-001"], capabilities: ["view"] },
  ] });
  return ok(s, { action: "agree-story-plan", via: "html-review" });
}

describe("S12: exclude and restore leave the agreed plan as it was", () => {
  it("exclude then restore: the line has no excluded-only fields, the fingerprint is the agreed one, the agreement still stands", () => {
    const agreed = guidedPlan();
    const fp = storyPlanFingerprint(agreed.storyPlan);
    let s = ok(agreed, { action: "update-story-plan", operations: [{ op: "exclude", id: "US-ORD-002", reason: "[test] exclude" }] });
    expect(s.storyPlan!.entries[1]).toMatchObject({ status: "excluded", excludedReason: "[test] exclude" });
    expect(acceptanceStatus(s, "story_plan")).toBe("stale");
    s = ok(s, { action: "update-story-plan", operations: [{ op: "restore", id: "US-ORD-002" }] });
    expect(s.storyPlan!.entries[1]).not.toHaveProperty("excludedReason");
    expect(storyPlanFingerprint(s.storyPlan)).toBe(fp);
  });

  it("a plan line that kept a reason after a restore (state written before the fix) does not turn the agreement stale", () => {
    const agreed = guidedPlan();
    const poisoned = { ...agreed, storyPlan: { ...agreed.storyPlan!, entries: agreed.storyPlan!.entries.map((e, i) => (i === 1 ? { ...e, status: "planned" as const, excludedReason: "left over" } : e)) } };
    expect(acceptanceStatus(WorkflowStateSchema.parse(poisoned), "story_plan")).toBe("accepted");
  });

  it("while the line is excluded its reason is part of what was agreed, so changing it is a change", () => {
    const agreed = guidedPlan();
    const a = ok(agreed, { action: "update-story-plan", operations: [{ op: "exclude", id: "US-ORD-002", reason: "one" }] });
    const b = ok(agreed, { action: "update-story-plan", operations: [{ op: "exclude", id: "US-ORD-002", reason: "two" }] });
    expect(storyPlanFingerprint(a.storyPlan)).not.toBe(storyPlanFingerprint(b.storyPlan));
  });
});

describe("S8 / S12: gates between the stages", () => {
  /** A classic state (so stories can be added directly) with both reviews accepted: the gates are computed the same way in guided mode. */
  function withStories(confirm: boolean): WorkflowState {
    let s = apply(null, { action: "open", projectId: "orders", title: "Orders", request: "Orders", mode: "classic" }).state;
    s = ok(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers filter orders", acceptanceCriteria: ["Filter works"] });
    for (const id of ["US-ORD-001", "US-ORD-002"])
      s = ok(s, { action: "add-story", id, requirementIds: ["REQ-ORD-001"], actor: "manager", narrative: "As a manager, I want to filter, so that I find orders.", objective: "o", userValue: "v", happyPath: ["do"], acceptanceCriteria: [{ id: `${id}-AC-01`, given: "g", when: "w", then: "t" }], expectedResults: ["done"], confirmedBehavior: false, capabilities: ["view", "filter", "states", "search"] });
    if (confirm) s = { ...s, stories: s.stories.map((st) => ({ ...st, confirmedBehavior: true, status: "confirmed" as const })) };
    const stamp = (phase: "stories_review") => ({ at: NOW.toISOString(), via: "html-review" as const, fingerprint: currentFingerprint(s, phase), revision: 1 });
    return { ...s, phaseAcceptance: { ...s.phaseAcceptance, stories_review: stamp("stories_review") } as never };
  }

  it("the Architect gate needs every story confirmed: reviewing and confirming are two decisions", () => {
    const missing = phaseGates(withStories(false), "architecture").missing.join("\n");
    expect(missing).toContain("every story confirmed by the user (confirm-story): US-ORD-001, US-ORD-002 still need it");
    expect(phaseGates(withStories(true), "architecture").missing.join("\n")).not.toContain("confirm-story");
  });

  it("an upstream acceptance that went stale holds the later gates, naming what changed", () => {
    const s = withStories(true);
    const staleReqs = { ...s, phaseAcceptance: { ...s.phaseAcceptance, requirements_review: { at: NOW.toISOString(), via: "html-review" as const, fingerprint: "old", revision: 1 } } as never };
    for (const to of ["architecture", "development", "quality"] as const) expect(phaseGates(staleReqs, to).missing.join("\n"), to).toContain("the requirements changed after you accepted them: review and accept again");
    const stalePlan = { ...s, phaseAcceptance: { ...s.phaseAcceptance, story_plan: { at: NOW.toISOString(), via: "html-review" as const, fingerprint: "old", revision: 1 } } as never };
    expect(phaseGates(stalePlan, "architecture").missing.join("\n")).toContain("the story plan changed after you accepted it: review and accept again");
    expect(phaseGates(s, "architecture").missing.join("\n")).not.toContain("changed after you accepted");
  });
});
