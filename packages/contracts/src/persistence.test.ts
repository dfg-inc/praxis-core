import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, redactPersistent, WorkflowStateSchema, type WorkflowState } from "./index.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const ok = (s: WorkflowState | null, c: Record<string, unknown>) => applyWorkflowCommand(s, c, { now: NOW, channel: { via: "html-review" } }).state;

/** What the Runtime writes to disk is redactPersistent(state); it must read back as the same state. */
describe("persisted state survives the secret redaction", () => {
  it("every planning artifact reads back unchanged", () => {
    let s = ok(null, { action: "open", projectId: "p", title: "Orders", request: "r", mode: "guided" });
    s = ok(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "View orders", acceptanceCriteria: ["List shows orders"] });
    s = ok(s, { action: "accept-requirements" });
    s = ok(s, {
      action: "set-prototype",
      prototype: {
        kind: "ui",
        title: "Orders",
        startScreen: "list",
        styles: { colors: { primary: "#112233" }, fonts: { body: "Inter" }, radius: "8px", sources: [{ file: "src/theme.css" }] },
        mock: [{ id: "orders", name: "Orders", fields: [{ key: "number", label: "Number", type: "string" }], rows: [{ number: "A-1" }] }],
        screens: [{ id: "list", title: "List", elements: [{ id: "t", kind: "table", collection: "orders", requirementIds: ["REQ-ORD-001"] }] }],
      },
    });
    s = ok(s, { action: "register-repository", repository: { id: "web", name: "Web", role: "frontend", localPath: "/tmp/web" } });
    s = ok(s, { action: "record-repository-inspection", repositoryId: "web", inspection: { at: NOW.toISOString(), summary: "React", frameworks: ["react"], instructionFiles: ["CLAUDE.md"], entries: [], frontend: { hasStyles: true, styleFiles: ["src/index.css"], componentDirs: [] } } });
    const stored = JSON.parse(JSON.stringify(redactPersistent(s)));
    expect(JSON.stringify(stored)).not.toContain("[redacted]");
    expect(WorkflowStateSchema.parse(stored)).toEqual(WorkflowStateSchema.parse(JSON.parse(JSON.stringify(s))));
  });
});
