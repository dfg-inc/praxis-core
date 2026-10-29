// @vitest-environment node
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { analyzeStoryCoverage, applyWorkflowCommand, capabilityEvidence, maskLiterals, renderReview, ReviewSubmissionSchema, statedOperations, submissionToCommands, type WorkflowState } from "./index.js";

const NOW = new Date("2026-10-28T10:00:00.000Z");
const apply = (s: WorkflowState | null, c: Record<string, unknown>) => applyWorkflowCommand(s, c, { now: NOW, channel: { via: "html-review" } });
const ok = (s: WorkflowState, c: Record<string, unknown>) => apply(s, c).state;

function item(statement: string, criteria: string[]): WorkflowState {
  let s = apply(null, { action: "open", projectId: "orders", title: "Orders", request: "Orders", mode: "guided" }).state;
  s = ok(s, { action: "add-requirement", id: "REQ-ORD-001", statement, acceptanceCriteria: criteria });
  return ok(s, { action: "accept-requirements", via: "html-review" });
}
const plan = (caps: string[][]) => caps.map((capabilities, i) => ({ id: `US-ORD-00${i + 1}`, title: `Story ${i + 1}`, implementation: "implementation", userGets: "something", requirementIds: ["REQ-ORD-001"], capabilities }));

describe("S1/S4: capabilities follow what the requirement says and what was built, not words inside data", () => {
  const ORDERS_ACS = [
    "The filter «Status» has the values: All, New, In progress, Shipped, Delivered, Cancelled",
    "Selecting a status adds ?status=New to the URL; selecting All removes the status parameter",
    "If the query names an order that does not exist the panel does not open and order is removed from the URL",
    "When nothing matches, the message 'No orders with status Cancelled' and a button to reset the filter are shown",
  ];

  it("the original orders read-only filter is not asked for create, delete or search", () => {
    let s = item("Managers can filter the list of orders by one status", ORDERS_ACS);
    s = ok(s, { action: "set-story-plan", entries: plan([["filter", "view", "states"]]) });
    const report = analyzeStoryCoverage(s);
    expect(report.gaps).toEqual([]);
    expect(report.ok).toBe(true);
    // the suggestions say which phrase fired and never block
    for (const a of report.advisories) expect(a.reason).toMatch(/A suggestion, not a gap/);
  });

  it("status values from the prototype are data: New and Cancelled are not create and delete", () => {
    let s = item("Managers can open the orders page", ["Orders with status New or Cancelled are listed"]);
    s = ok(s, { action: "set-prototype", prototype: { kind: "ui", title: "P", startScreen: "l", mock: [{ id: "o", name: "O", fields: [{ key: "status", label: "Status", type: "enum", options: ["New", "Cancelled"] }], rows: [{ status: "New" }] }], screens: [{ id: "l", title: "L", elements: [{ id: "t", kind: "table", collection: "o", columns: ["status"], requirementIds: ["REQ-ORD-001"] }] }] } });
    expect(capabilityEvidence(maskLiterals("Orders with status New or Cancelled are listed", ["New", "Cancelled"])).map((e) => e.capability)).toEqual(["view"]);
    s = ok(s, { action: "set-story-plan", entries: plan([["view", "states"]]) });
    expect(analyzeStoryCoverage(s).gaps).toEqual([]);
  });

  it("real CRUD wording in the requirement still asks for create, edit and delete, and says which words did", () => {
    let s = item("Managers can create, edit and delete orders", ["An order can be created"]);
    s = ok(s, { action: "set-story-plan", entries: plan([["view"]]) });
    const gap = analyzeStoryCoverage(s).gaps[0]!;
    expect(gap.missing).toEqual(expect.arrayContaining(["create", "edit", "delete"]));
    expect(gap.because.delete).toContain('the statement says "delete"');
    expect(analyzeStoryCoverage(s).ok).toBe(false);
  });

  it("the words around an operation do not count: only what the statement says a user can do", () => {
    expect(statedOperations("Managers can filter orders; the new status is removed later")).toEqual([{ capability: "filter", phrase: "filter" }]);
    expect(statedOperations("The list shows new orders and cancelled ones")).toEqual([]);
    expect(maskLiterals('Click «Delete all» or "remove" or ?query=x or `create`')).not.toMatch(/Delete|remove|query|create/);
  });

  it("what the prototype built asks for its capability, with the element named", () => {
    let s = item("Managers work with orders", ["x"]);
    s = ok(s, { action: "set-prototype", prototype: { kind: "ui", title: "P", startScreen: "l", mock: [{ id: "o", name: "O", fields: [{ key: "n", label: "N", type: "string" }], rows: [] }], screens: [{ id: "l", title: "L", elements: [{ id: "f", kind: "filter", param: "status", collection: "o", filters: [{ param: "status", field: "n" }], requirementIds: ["REQ-ORD-001"] }] }] } });
    s = ok(s, { action: "set-story-plan", entries: plan([["view"]]) });
    const gap = analyzeStoryCoverage(s).gaps[0]!;
    expect(gap.missing).toContain("filter");
    expect(gap.because.filter).toContain("prototype element l#f");
  });
});

describe("S2/S3: waivers in the review page, with the agreement in the same submission", () => {
  function blocked(): WorkflowState {
    const s = item("Managers can create, edit and delete orders", ["An order can be created"]);
    return ok(s, { action: "set-story-plan", entries: plan([["view"]]) });
  }
  const page = (s: WorkflowState) => {
    const dom = new JSDOM(renderReview(s, "story-plan", { token: "t0k" }), { runScripts: "dangerously", pretendToBeVisual: true });
    const doc = dom.window.document;
    const decisions = () => {
      (doc.querySelector("#btn-copy") as HTMLElement).click();
      return JSON.parse((doc.querySelector("#out textarea") as HTMLTextAreaElement).value);
    };
    return { dom, doc, decisions };
  };

  it("the page lists each blocking gap with what asked for it and a waive control", () => {
    const { doc } = page(blocked());
    const gaps = [...doc.querySelectorAll("[data-gap]")].map((g) => `${g.getAttribute("data-req")}:${g.getAttribute("data-kind")}`);
    expect(gaps).toEqual(expect.arrayContaining(["REQ-ORD-001:create", "REQ-ORD-001:edit", "REQ-ORD-001:delete"]));
    expect(doc.querySelector("[data-gap]")!.textContent).toContain("asked for by: the statement says");
  });

  it("a waiver saved with the agreement is applied first, so the plan can be agreed in one submission", () => {
    const s = blocked();
    const p = page(s);
    for (const kind of ["create", "edit", "delete"]) {
      const row = p.doc.querySelector(`[data-gap][data-kind="${kind}"]`)!;
      (row.querySelector("[data-f=waive]") as HTMLInputElement).checked = true;
      (row.querySelector("[data-f=waive-reason]") as HTMLInputElement).value = `${kind} ships in the next story set`;
    }
    (p.doc.querySelector("#agree-plan") as HTMLInputElement).checked = true;
    const submission = ReviewSubmissionSchema.parse(p.decisions());
    const planned = submissionToCommands(s, submission);
    expect(planned.conflicts).toEqual([]);
    expect(planned.commands.map((c) => c.action)).toEqual(["waive-coverage", "waive-coverage", "waive-coverage", "agree-story-plan"]);
    let next = s;
    for (const command of planned.commands) next = ok(next, command);
    expect(next.storyPlan!.status).toBe("agreed");
    expect(next.waivers).toHaveLength(3);
    expect(next.waivers[0]).toMatchObject({ kind: "create", requirementId: "REQ-ORD-001", decidedVia: "html-review" });
    expect(next.waivers[0]!.gap).toContain('the statement says "create"');
  });

  it("a waiver without a reason is refused by the page and by the contract; a waiver never closes a criterion no story covers", () => {
    const s = blocked();
    const p = page(s);
    (p.doc.querySelector("[data-gap] [data-f=waive]") as HTMLInputElement).checked = true;
    (p.doc.querySelector("#btn-save") as HTMLElement).click();
    expect(p.doc.querySelector("#toast")!.textContent).toMatch(/reason/);
    expect(() => ReviewSubmissionSchema.parse({ contract: "praxis.review.submission", version: 1, reviewId: "x", view: "story-plan", workItemId: s.workItem.id, baseFingerprint: "x", submittedAt: NOW.toISOString(), waivers: [{ kind: "create", reason: "" }] })).toThrow();
    expect(analyzeStoryCoverage(s).criteriaWithoutStory.length + analyzeStoryCoverage(s).gaps.length).toBeGreaterThan(0);
  });
});
