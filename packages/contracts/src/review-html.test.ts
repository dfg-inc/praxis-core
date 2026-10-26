// @vitest-environment node
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  applyWorkflowCommand,
  renderReview,
  reviewProgress,
  storyReviewProgress,
  storyContentFingerprint,
  submissionToCommands,
  ReviewSubmissionSchema,
  type ReviewView,
  type WorkflowState,
} from "./index.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const apply = (state: WorkflowState | null, command: Record<string, unknown>) => applyWorkflowCommand(state, command, { now: NOW, channel: { via: "html-review" } });
const ok = (state: WorkflowState, command: Record<string, unknown>) => apply(state, command).state;

function base(): WorkflowState {
  let s = apply(null, { action: "open", projectId: "orders", title: "Order list", request: "Managers manage orders", mode: "guided" }).state;
  s = ok(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view and search orders", acceptanceCriteria: ["The list shows all orders", "A manager can search by number"] });
  s = ok(s, { action: "add-requirement", id: "REQ-ORD-002", statement: "Managers can export <b>CSV</b>", acceptanceCriteria: ["Export contains the filtered rows"] });
  return s;
}

function withPrototype(s: WorkflowState): WorkflowState {
  s = ok(s, { action: "accept-requirements", via: "html-review" });
  return ok(s, {
    action: "set-prototype",
    prototype: {
      kind: "ui",
      title: "Orders",
      notes: "",
      startScreen: "list",
      roles: ["manager", "viewer"],
      mock: [{ id: "orders", name: "Orders", fields: [{ key: "number", label: "Number", type: "string" }], rows: [{ number: "A-1" }, { number: "B-2" }] }],
      screens: [
        {
          id: "list",
          title: "Order list",
          description: "",
          states: ["default", "empty", "error"],
          stateMessages: { error: "Cannot load orders" },
          elements: [
            { id: "tbl", kind: "table", label: "Orders", collection: "orders", columns: ["number"], intent: "view", allowedRoles: [], requirementIds: ["REQ-ORD-001"], acIds: [] },
            { id: "add", kind: "button", label: "Add order", action: "add-row", collection: "orders", allowedRoles: ["manager"], requirementIds: [], acIds: [] },
            { id: "go", kind: "button", label: "Details", navigatesTo: "detail", allowedRoles: [], requirementIds: [], acIds: [] },
          ],
        },
        { id: "detail", title: "Order details", description: "", states: ["default"], stateMessages: {}, elements: [{ id: "h", kind: "heading", label: "Order", allowedRoles: [], requirementIds: [], acIds: [] }] },
      ],
      endpoints: [],
    },
    summary: "first version",
  });
}

function page(state: WorkflowState, view: ReviewView, saveUrl?: string) {
  const html = renderReview(state, view, { saveUrl, token: "t0k" });
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  const doc = dom.window.document;
  const decisions = () => {
    (doc.querySelector("#btn-copy") as HTMLElement).click();
    return JSON.parse((doc.querySelector("#out textarea") as HTMLTextAreaElement).value);
  };
  return { html, dom, doc, decisions };
}

function applyPlan(state: WorkflowState, submission: unknown) {
  const plan = submissionToCommands(state, submission);
  let next = state;
  for (const command of plan.commands) next = ok(next, command);
  return { next, plan };
}

describe("HTML requirements review", () => {
  it("renders every requirement with a control per criterion and escapes content", () => {
    const { html, doc } = page(base(), "requirements");
    expect(doc.querySelectorAll("[data-req]").length).toBe(2);
    expect(doc.querySelectorAll("[data-ac]").length).toBe(3);
    expect(doc.querySelectorAll("[data-ac] input[type=radio]").length).toBe(9);
    expect(html).not.toContain("<b>CSV</b>");
    expect(html).toContain("&lt;b&gt;CSV&lt;/b&gt;");
    expect(doc.title).toBe("Requirements review");
    expect(doc.querySelectorAll("script[src],link[href],img[src]").length).toBe(0);
  });

  it("round-trips per-criterion decisions, a point edit and a scope change into the workflow state", () => {
    const s = base();
    const p = page(s, "requirements");
    const r = (id: string, v: string) => (p.doc.querySelector(`[data-ac="${id}"] input[value=${v}]`) as HTMLInputElement).click();
    r("REQ-ORD-001-AC-01", "accepted");
    r("REQ-ORD-001-AC-02", "rejected");
    (p.doc.querySelector('[data-ac="REQ-ORD-001-AC-02"] [data-f=ac-comment]') as HTMLInputElement).value = "also by phone";
    (p.doc.querySelector('[data-req="REQ-ORD-002"] [data-f=scope]') as HTMLSelectElement).value = "deferred";
    const ta = p.doc.querySelector('[data-req="REQ-ORD-001"] [data-f=statement]') as HTMLTextAreaElement;
    ta.value = "Managers can view, search and filter orders";
    const submission = ReviewSubmissionSchema.parse(p.decisions());
    expect(submission.view).toBe("requirements");
    const { next, plan } = applyPlan(s, submission);
    expect(plan.conflicts).toEqual([]);
    const req = next.requirements[0];
    expect(req.statement).toMatch(/filter/);
    expect(req.revision).toBe(2);
    expect(next.requirements[1].scope).toBe("deferred");
    expect(req.acceptanceCriteria.map((c) => c.review.status)).toEqual(["accepted", "rejected"]); // marks survive a statement edit; only edited criteria reset
  });

  it("marks criteria without touching the text and keeps unedited requirements at their revision", () => {
    const s = base();
    const p = page(s, "requirements");
    (p.doc.querySelector('[data-ac="REQ-ORD-001-AC-01"] input[value=accepted]') as HTMLInputElement).click();
    const { next } = applyPlan(s, p.decisions());
    expect(next.requirements[0].revision).toBe(1);
    expect(next.requirements[0].acceptanceCriteria[0].review).toMatchObject({ status: "accepted", via: "html-review" });
    expect(reviewProgress(next).accepted).toBe(1);
  });

  it("adds and removes criteria from the page", () => {
    const s = base();
    const p = page(s, "requirements");
    (p.doc.querySelector('[data-req="REQ-ORD-002"] [data-f=add-ac]') as HTMLTextAreaElement).value = "Export is limited to 10000 rows\nExport has a header row";
    (p.doc.querySelector('[data-ac="REQ-ORD-002-AC-01"] [data-f=remove]') as HTMLInputElement).click();
    const { next } = applyPlan(s, p.decisions());
    expect(next.requirements[1].acceptanceCriteria.map((c) => c.statement)).toEqual(["Export is limited to 10000 rows", "Export has a header row"]);
  });

  it("completing the review accepts the requirements phase", () => {
    const s = base();
    const p = page(s, "requirements");
    p.doc.querySelector<HTMLButtonElement>("#btn-accept-all")!.click();
    p.doc.querySelector<HTMLInputElement>("#accept-all")!.click();
    const { next } = applyPlan(s, p.decisions());
    expect(reviewProgress(next).complete).toBe(true);
    expect(next.phaseAcceptance.requirements_review?.via).toBe("html-review");
  });

  it("reports a conflict when the requirement was edited after the page was rendered, and still applies the other items", () => {
    const s = base();
    const p = page(s, "requirements");
    (p.doc.querySelector('[data-req="REQ-ORD-001"] [data-f=statement]') as HTMLTextAreaElement).value = "My edit";
    (p.doc.querySelector('[data-ac="REQ-ORD-002-AC-01"] input[value=accepted]') as HTMLInputElement).click();
    const submission = p.decisions();
    const moved = ok(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", statement: "Someone else's edit" }] });
    const { next, plan } = applyPlan(moved, submission);
    expect(plan.stale).toBe(true);
    expect(plan.conflicts.map((c) => c.item)).toEqual(["REQ-ORD-001"]);
    expect(next.requirements[0].statement).toBe("Someone else's edit");
    expect(next.requirements[1].acceptanceCriteria[0].review.status).toBe("accepted");
  });

  it("does not apply a review for another work item", () => {
    const s = base();
    const submission = { ...page(s, "requirements").decisions(), workItemId: "WI-OTHER" };
    const plan = submissionToCommands(s, submission);
    expect(plan.commands).toEqual([]);
    expect(plan.conflicts[0].item).toBe("work item");
  });

  it("falls back to a copyable payload when there is no live connection", () => {
    const p = page(base(), "requirements");
    p.doc.querySelector<HTMLButtonElement>("#btn-save")!.click();
    expect((p.doc.querySelector("#out") as HTMLElement).style.display).toBe("block");
    expect(JSON.parse((p.doc.querySelector("#out textarea") as HTMLTextAreaElement).value).contract).toBe("praxis.review.submission");
  });
});

describe("HTML prototype review", () => {
  it("shows screens on mock data, navigates, switches state and role, and edits only the in-memory copy", () => {
    const s = withPrototype(base());
    const p = page(s, "prototype");
    const host = p.doc.querySelector("#proto-screen") as HTMLElement;
    expect(host.textContent).toContain("A-1");
    expect(host.textContent).toContain("Add order");
    (p.doc.querySelector<HTMLSelectElement>("#proto-role")!).value = "viewer";
    p.doc.querySelector<HTMLSelectElement>("#proto-role")!.dispatchEvent(new p.dom.window.Event("change"));
    expect(host.textContent).toContain('Not available for role "viewer"');
    (p.doc.querySelector<HTMLSelectElement>("#proto-role")!).value = "manager";
    p.doc.querySelector<HTMLSelectElement>("#proto-role")!.dispatchEvent(new p.dom.window.Event("change"));
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Add order")!.click();
    expect(host.querySelectorAll("tr").length).toBe(4);
    p.doc.querySelector<HTMLButtonElement>("#proto-reset")!.click();
    expect(host.querySelectorAll("tr").length).toBe(3);
    const sw = p.doc.querySelector<HTMLSelectElement>("#proto-state")!;
    sw.value = "error";
    sw.dispatchEvent(new p.dom.window.Event("change"));
    expect(host.textContent).toContain("Cannot load orders");
    sw.value = "default";
    sw.dispatchEvent(new p.dom.window.Event("change"));
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Details")!.click();
    expect(host.textContent).toContain("Order details");
    expect(s.prototype!.mock[0].rows.length).toBe(2);
  });

  it("records element comments and acceptance", () => {
    const s = withPrototype(base());
    const p = page(s, "prototype");
    [...p.doc.querySelectorAll<HTMLButtonElement>("#proto-screen button")].find((b) => b.getAttribute("aria-label") === "Comment on tbl")!.click();
    (p.doc.querySelector('[data-fb="list#tbl"]') as HTMLTextAreaElement).value = "add a status column";
    p.doc.querySelector<HTMLInputElement>("#accept-proto")!.click();
    const { next, plan } = applyPlan(s, p.decisions());
    expect(plan.conflicts).toEqual([]);
    expect(next.prototype!.feedback[0]).toMatchObject({ target: "list#tbl", comment: "add a status column" });
    expect(next.phaseAcceptance.prototype).toBeDefined();
  });

  it("a prototype changed after rendering cannot be accepted blindly", () => {
    const s = withPrototype(base());
    const p = page(s, "prototype");
    p.doc.querySelector<HTMLInputElement>("#accept-proto")!.click();
    const submission = p.decisions();
    const moved = ok(s, { action: "update-prototype", operations: [{ op: "set-meta", title: "Orders v2" }] });
    const plan = submissionToCommands(moved, submission);
    expect(plan.stale).toBe(true);
    expect(plan.commands.find((c) => c.action === "accept-prototype")).toBeUndefined();
  });

  it("an API prototype renders request and response examples without screens", () => {
    let s = ok(base(), { action: "accept-requirements", via: "html-review" });
    s = ok(s, { action: "set-prototype", prototype: { kind: "api", title: "Orders API", notes: "", screens: [], mock: [], roles: [], endpoints: [{ id: "list", method: "GET", path: "/orders", summary: "List orders", requirementIds: ["REQ-ORD-001"], acIds: [], responses: [{ status: 200, description: "ok", example: { items: [] } }] }] } });
    const { html } = page(s, "prototype");
    expect(html).toContain("/orders");
    expect(html).not.toContain('id="proto-screen"');
  });

  it("styles come from tokens and unsafe values are dropped", () => {
    let s = withPrototype(base());
    s = ok(s, { action: "update-prototype", operations: [{ op: "set-tokens", tokens: { colors: { primary: "#112233", evil: "red;}</style><script>alert(1)</script>" }, fonts: {}, sources: [{ file: "src/theme.css" }] } }] });
    const { html } = page(s, "prototype");
    expect(html).toContain("--p-primary:#112233");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("src/theme.css");
  });
});

describe("HTML story plan and stories review", () => {
  function planned(): WorkflowState {
    let s = ok(base(), { action: "accept-requirements", via: "html-review" });
    s = ok(s, { action: "set-story-plan", entries: [{ id: "US-ORD-001", title: "View orders", implementation: "List page", userGets: "all orders", requirementIds: ["REQ-ORD-001"], capabilities: ["view", "search"] }, { id: "US-ORD-002", title: "Export", implementation: "CSV", userGets: "a file", requirementIds: ["REQ-ORD-002"], capabilities: ["filter"] }] });
    return s;
  }

  it("edits, reviews, excludes and agrees plan lines", () => {
    const s = planned();
    const p = page(s, "story-plan");
    expect(p.doc.querySelectorAll("[data-entry]").length).toBe(2);
    p.doc.querySelector<HTMLInputElement>('[data-entry="US-ORD-001"] input[value=accepted]')!.click();
    (p.doc.querySelector('[data-entry="US-ORD-001"] [data-f=implementation]') as HTMLTextAreaElement).value = "List page with paging";
    (p.doc.querySelector('[data-entry="US-ORD-002"] [data-f=exclude]') as HTMLInputElement).value = "next release";
    const { next, plan } = applyPlan(s, p.decisions());
    expect(plan.conflicts).toEqual([]);
    const e1 = next.storyPlan!.entries[0];
    expect(e1.implementation).toBe("List page with paging");
    expect(next.storyPlan!.entries[1].status).toBe("excluded");
  });

  it("agreeing the plan is skipped when part of the review failed", () => {
    const s = planned();
    const p = page(s, "story-plan");
    p.doc.querySelector<HTMLInputElement>("#agree-plan")!.click();
    const submission = p.decisions();
    const { plan } = applyPlan(s, submission);
    expect(plan.commands.map((c) => c.action)).toContain("agree-story-plan");
    const bad = { ...submission, plan: { ...submission.plan, entries: [{ id: "US-ORD-099", status: "accepted" }] } };
    const result = submissionToCommands(s, bad);
    expect(result.commands.find((c) => c.action === "agree-story-plan")).toBeUndefined();
    expect(result.conflicts.some((c) => c.item === "US-ORD-099")).toBe(true);
  });

  function withStories(): WorkflowState {
    let s = planned();
    s = ok(s, { action: "agree-story-plan", via: "html-review" });
    s = ok(s, { action: "add-story", id: "US-ORD-001", requirementIds: ["REQ-ORD-001"], actor: "manager", narrative: "As a manager, I want orders, so that I see them.", objective: "o", userValue: "v", happyPath: ["open list", "search"], acceptanceCriteria: [{ id: "US-ORD-001-AC-01", given: "orders exist", when: "I open the list", then: "I see them" }], expectedResults: ["list shown"], confirmedBehavior: false });
    return s;
  }

  it("has a control for every reviewable item and records marks per item", () => {
    const s = withStories();
    const p = page(s, "stories");
    const rows = p.doc.querySelectorAll('[data-story="US-ORD-001"] [data-key]');
    expect(rows.length).toBe(1 + 2 + 1);
    p.doc.querySelector<HTMLInputElement>('[data-key="step:0"] input[value=accepted]')!.click();
    p.doc.querySelector<HTMLInputElement>('[data-key="ac:US-ORD-001-AC-01"] input[value=rejected]')!.click();
    const { next, plan } = applyPlan(s, p.decisions());
    expect(plan.conflicts).toEqual([]);
    expect(next.stories[0].review["step:0"].status).toBe("accepted");
    expect(next.stories[0].review["ac:US-ORD-001-AC-01"].status).toBe("rejected");
    expect(storyReviewProgress(next)).toMatchObject({ accepted: 1, rejected: 1, pending: 2 });
  });

  it("accepting a whole story marks all its items", () => {
    const s = withStories();
    const p = page(s, "stories");
    p.doc.querySelector<HTMLInputElement>('[data-story="US-ORD-001"] [data-f=accept-story]')!.click();
    const { next } = applyPlan(s, p.decisions());
    expect(storyReviewProgress(next).complete).toBe(true);
  });

  it("editing story text through the review creates a new revision and drops that story's marks", () => {
    const s = withStories();
    const p = page(s, "stories");
    p.doc.querySelector<HTMLInputElement>('[data-key="step:0"] input[value=accepted]')!.click();
    (p.doc.querySelector('[data-story="US-ORD-001"] [data-f=objective]') as HTMLTextAreaElement).value = "see all orders quickly";
    const { next } = applyPlan(s, p.decisions());
    expect(next.stories[0].objective).toBe("see all orders quickly");
    expect(next.stories[0].revision).toBe(2);
    expect(next.stories[0].review["step:0"]).toBeUndefined();
  });

  it("a story edited elsewhere after rendering is reported, not overwritten", () => {
    const s = withStories();
    const p = page(s, "stories");
    p.doc.querySelector<HTMLInputElement>('[data-story="US-ORD-001"] [data-f=accept-story]')!.click();
    const submission = p.decisions();
    const moved = ok(s, { action: "update-story", id: "US-ORD-001", patch: { objective: "changed" }, reason: "x" });
    const { next, plan } = applyPlan(moved, submission);
    expect(plan.conflicts.map((c) => c.item)).toContain("US-ORD-001");
    expect(next.stories[0].review["step:0"]).toBeUndefined();
    expect(storyContentFingerprint(next.stories[0])).toBeTruthy();
  });

  it("excluding a story from the review shows it as excluded", () => {
    const s = withStories();
    const p = page(s, "stories");
    (p.doc.querySelector('[data-story="US-ORD-001"] [data-f=exclude]') as HTMLInputElement).value = "not needed";
    const { next } = applyPlan(s, p.decisions());
    expect(next.stories[0].status).toBe("excluded");
    expect(page(next, "stories").html).toContain("Restore this story");
  });
});
