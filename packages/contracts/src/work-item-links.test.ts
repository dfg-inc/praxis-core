import { describe, expect, it } from "vitest";
import {
  applyWorkflowCommand,
  openLocalWorkflow,
  WorkflowStateSchema,
  workItemIdFor,
} from "./index.js";

describe("work item ids", () => {
  it("derives stable ids and honors an explicit sequence", () => {
    expect(workItemIdFor("Fix the thing")).toBe("WI-FIX-THE-THING-001");
    expect(workItemIdFor("Fix the thing", 12)).toBe("WI-FIX-THE-THING-012");
    const opened = openLocalWorkflow({ projectId: "p", title: "Fix the thing", request: "r", sequence: 2 });
    expect(opened.workItem.id).toBe("WI-FIX-THE-THING-002");
    expect(opened.workflowId).toBe("WF-WI-FIX-THE-THING-002");
  });
});

describe("cross-repository work item links", () => {
  const base = () => openLocalWorkflow({ projectId: "p", title: "Linked", request: "r" });
  const target = { repository: "praxis-runtime", workItemId: "WI-OTHER-001", relation: "depends-on" as const };

  it("adds a link once, bumps the revision, and removes it", () => {
    const added = applyWorkflowCommand(base(), { action: "link-work-item", target });
    expect(added.duplicate).toBe(false);
    expect(added.state.workItem.links).toEqual([target]);
    expect(added.state.workItem.revision).toBe(2);
    const again = applyWorkflowCommand(added.state, { action: "link-work-item", target });
    expect(again.duplicate).toBe(true);
    expect(again.state.workItem.links).toEqual([target]);
    const removed = applyWorkflowCommand(added.state, { action: "link-work-item", target, remove: true });
    expect(removed.state.workItem.links).toEqual([]);
  });

  it("rejects an unknown relation", () => {
    expect(() =>
      applyWorkflowCommand(base(), { action: "link-work-item", target: { ...target, relation: "owns" as never } }),
    ).toThrow();
  });

  it("states persisted before links existed still parse", () => {
    const legacy = JSON.parse(JSON.stringify(base()));
    expect(legacy.workItem.links).toBeUndefined();
    expect(() => WorkflowStateSchema.parse(legacy)).not.toThrow();
  });
});
