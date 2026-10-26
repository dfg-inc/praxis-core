import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, buildResumeBriefing } from "./index.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const ok = (s: any, c: Record<string, unknown>) => applyWorkflowCommand(s, c, { now: NOW }).state;

describe("resume briefing", () => {
  it("restores state from records and says what it cannot restore", () => {
    let s = ok(null, { action: "open", projectId: "p", title: "Orders", request: "Managers manage orders", mode: "guided" });
    s = ok(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "View orders", acceptanceCriteria: ["List shows orders"] });
    s = ok(s, { action: "record-decision", id: "DEC-1", statement: "Paging is server-side", confirmed: false });
    s = ok(s, { action: "log-session", summary: "Collected requirements", nextAction: "review them", role: "ba" });
    const b = buildResumeBriefing(s);
    expect(b.workItem).toMatchObject({ id: s.workItem.id, title: "Orders", mode: "guided", request: "Managers manage orders" });
    expect(b.next.action).toBeTruthy();
    expect(b.progress.requirements).toMatchObject({ criteria: 1, pending: 1 });
    expect(b.decisions).toEqual([{ id: "DEC-1", statement: "Paging is server-side", confirmed: false }]);
    expect(b.lastSessions[0]).toMatchObject({ summary: "Collected requirements", nextAction: "review them" });
    expect(b.notRestored).toMatch(/earlier chat messages/);
  });
});
