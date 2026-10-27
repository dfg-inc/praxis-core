// @vitest-environment node
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, renderReview, submissionToCommands, type ReviewView, type WorkflowState } from "./index.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const LATER = new Date("2026-10-26T11:00:00.000Z");
const ok = (state: WorkflowState | null, command: Record<string, unknown>, now = NOW) => applyWorkflowCommand(state, command, { now, channel: { via: "html-review" } }).state;

function base(): WorkflowState {
  let s = ok(null, { action: "open", projectId: "orders", title: "Order list", request: "r", mode: "guided" });
  s = ok(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers view orders", acceptanceCriteria: ["The list shows all orders", "A manager can search"] });
  s = ok(s, { action: "add-requirement", id: "REQ-ORD-002", statement: "Managers export CSV", acceptanceCriteria: ["Export has the filtered rows"] });
  return s;
}
function planned(): WorkflowState {
  let s = ok(base(), { action: "accept-requirements", via: "html-review" });
  return ok(s, { action: "set-story-plan", entries: [{ id: "US-ORD-001", title: "View orders", implementation: "List page", userGets: "all orders", requirementIds: ["REQ-ORD-001"], capabilities: ["view", "search"] }, { id: "US-ORD-002", title: "Export", implementation: "CSV", userGets: "a file", requirementIds: ["REQ-ORD-002"], capabilities: ["filter"] }] });
}
function withStories(): WorkflowState {
  let s = ok(planned(), { action: "agree-story-plan", via: "html-review" });
  return ok(s, { action: "add-story", id: "US-ORD-001", requirementIds: ["REQ-ORD-001"], actor: "manager", narrative: "As a manager, I want orders, so that I see them.", objective: "o", userValue: "v", happyPath: ["open list", "search"], acceptanceCriteria: [{ id: "US-ORD-001-AC-01", given: "orders exist", when: "I open the list", then: "I see them" }], expectedResults: ["list shown"], confirmedBehavior: false });
}

/** The page exactly as the user's browser runs it. */
function page(state: WorkflowState, view: ReviewView) {
  const dom = new JSDOM(renderReview(state, view, { saveUrl: "http://x/submit", token: "t" }), { runScripts: "dangerously", pretendToBeVisual: true });
  const doc = dom.window.document;
  const q = <T extends Element>(sel: string) => doc.querySelector(sel) as unknown as T;
  const decisions = () => {
    q<HTMLElement>("#btn-copy").click();
    return JSON.parse(q<HTMLTextAreaElement>("#out textarea").value);
  };
  return { doc, q, decisions };
}
const strip = (value: unknown, keys: string[]): unknown => JSON.parse(JSON.stringify(value, (k, v) => (keys.includes(k) ? undefined : v)));
/** Any change to the work item at all: the page that was open before it is out of date. */
const touched = (s: WorkflowState) => ok(s, { action: "add-requirement", id: "REQ-ORD-099", statement: "Unrelated", acceptanceCriteria: ["x"] }, LATER);
const plan = (state: WorkflowState, submission: unknown) => submissionToCommands(state, submission);
const reasons = (p: ReturnType<typeof plan>) => p.conflicts.map((c) => c.reason).join(" | ");

describe("Requirements Review: every editable field is protected against an out-of-date tab", () => {
  const open = () => {
    const s = base();
    const p = page(s, "requirements");
    return { s, p };
  };

  it("scope, scope note and requirement remark changed elsewhere are conflicts; the page's own values still apply on a current state", () => {
    const { s, p } = open();
    p.q<HTMLSelectElement>('[data-req="REQ-ORD-001"] [data-f=scope]').value = "deferred";
    p.q<HTMLInputElement>('[data-req="REQ-ORD-001"] [data-f=scopeNote]').value = "later";
    p.q<HTMLInputElement>('[data-req="REQ-ORD-001"] [data-f=comment]').value = "my remark";
    const submission = p.decisions();
    expect(submission.requirements.requirements[0]).toMatchObject({ fromScope: "in", fromScopeNote: "", fromComment: "", scope: "deferred" });
    expect(plan(s, submission).conflicts).toEqual([]);
    // another tab set a scope note, a remark and moved the scope first
    let other = ok(s, { action: "set-requirement-scope", requirementIds: ["REQ-ORD-001"], scope: "excluded", note: "tab A note" }, LATER);
    other = ok(other, { action: "review-requirements", via: "html-review", decisions: [{ requirementId: "REQ-ORD-001", comment: "tab A remark", acceptance: [] }] }, LATER);
    const stale = plan(other, submission);
    expect(stale.commands).toHaveLength(0);
    expect(reasons(stale)).toMatch(/reload the page/);
  });

  it("an old save with the base values removed cannot get past the check (and a plain unbased save from a current page still works)", () => {
    const { s, p } = open();
    p.q<HTMLInputElement>('[data-ac="REQ-ORD-001-AC-01"] [data-f=ac-comment]').value = "page remark";
    p.q<HTMLInputElement>('[data-ac="REQ-ORD-001-AC-01"] input[value=rejected]').click();
    p.q<HTMLInputElement>('[data-req="REQ-ORD-002"] [data-f=comment]').value = "req remark";
    const submission = p.decisions();
    const stripped = strip(submission, ["from", "fromComment", "fromScope", "fromScopeNote"]) as Record<string, unknown>;
    // nothing changed since the page: a hand-made file without base values is fine
    expect(plan(s, stripped).conflicts).toEqual([]);
    // something changed (anything at all): the base values are now required for every field that changes
    const moved = touched(s);
    const refused = plan(moved, stripped);
    expect(refused.commands).toHaveLength(0);
    expect(refused.conflicts.length).toBe(2); // the criterion (decision and remark) and the requirement remark
    expect(reasons(refused)).toMatch(/does not say what it showed/);
    // the same save with its base values still applies: nothing it changes was touched
    expect(plan(moved, submission).conflicts).toEqual([]);
    // a file that does not even say what it showed is treated as out of date
    const noRevision = strip(stripped, ["baseStamp"]);
    expect(plan(s, noRevision).conflicts.length).toBe(2);
  });

  it("a criterion's remark, decision and wording changed in another tab are conflicts", () => {
    const { s, p } = open();
    p.q<HTMLInputElement>('[data-ac="REQ-ORD-001-AC-02"] input[value=accepted]').click();
    p.q<HTMLInputElement>('[data-ac="REQ-ORD-001-AC-02"] [data-f=ac-comment]').value = "tab B";
    const submission = p.decisions();
    const other = ok(s, { action: "review-requirements", via: "html-review", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-02", status: "rejected", comment: "tab A" }] }] }, LATER);
    const result = plan(other, submission);
    expect(result.commands).toHaveLength(0);
    expect(reasons(result)).toMatch(/reload the page/);
  });
});

describe("Story Plan: a line edited elsewhere is not overwritten, and the base cannot be left out", () => {
  it("edit, mark and remark carry the line's base; a different live line is a conflict", () => {
    const s = planned();
    const p = page(s, "story-plan");
    p.q<HTMLInputElement>('[data-entry="US-ORD-001"] input[value=accepted]').click();
    p.q<HTMLTextAreaElement>('[data-entry="US-ORD-001"] [data-f=implementation]').value = "List page with paging";
    const submission = p.decisions();
    expect(submission.baseStamp).toMatch(/^[0-9a-f]{24}$/);
    expect(submission.plan.entries[0].base).toMatch(/^[0-9a-f]{24}$/);
    expect(plan(s, submission).conflicts).toEqual([]);
    const other = ok(s, { action: "update-story-plan", via: "html-review", operations: [{ op: "update", id: "US-ORD-001", patch: { implementation: "tab A's text" } }] }, LATER);
    const stale = plan(other, submission);
    expect(stale.commands).toHaveLength(0);
    expect(reasons(stale)).toMatch(/plan line changed since you opened this page.*reload/);
    // the other tab only changed the remark/status: that is a change of the line too
    const other2 = ok(s, { action: "update-story-plan", via: "html-review", operations: [{ op: "review", id: "US-ORD-001", status: "rejected", comment: "no" }] }, LATER);
    expect(plan(other2, submission).commands).toHaveLength(0);
  });

  it("an old or hand-made save without the base is refused when the state moved, and accepted when it did not", () => {
    const s = planned();
    const p = page(s, "story-plan");
    p.q<HTMLInputElement>('[data-entry="US-ORD-002"] [data-f=exclude]').value = "next release";
    const submission = p.decisions();
    const stripped = strip(submission, ["base"]);
    expect(plan(s, stripped).conflicts).toEqual([]);
    const moved = ok(s, { action: "update-story-plan", via: "html-review", operations: [{ op: "update", id: "US-ORD-001", patch: { title: "Renamed elsewhere" } }] }, LATER);
    const refused = plan(moved, stripped);
    expect(refused.commands).toHaveLength(0);
    expect(reasons(refused)).toMatch(/does not say what it showed/);
  });
});

describe("Story Review: items, remarks and accept-all from an old page", () => {
  it("a mark or remark without its base values is refused after the state moved; accept-all from an old page is refused", () => {
    const s = withStories();
    const p = page(s, "stories");
    p.q<HTMLInputElement>('[data-key="step:0"] input[value=rejected]').click();
    p.q<HTMLInputElement>('[data-key="step:0"] [data-f=comment]').value = "what about paging?";
    const submission = p.decisions();
    expect(submission.stories.items[0]).toMatchObject({ from: "pending", fromComment: "", status: "rejected" });
    expect(plan(s, submission).conflicts).toEqual([]);
    const stripped = strip(submission, ["from", "fromComment"]);
    expect(plan(s, stripped).conflicts).toEqual([]);
    const moved = ok(s, { action: "review-stories", via: "html-review", items: [{ storyId: "US-ORD-001", revision: 1, key: "step:1", status: "accepted" }], acceptStories: [] }, LATER);
    expect(plan(moved, stripped).commands).toHaveLength(0);
    expect(reasons(plan(moved, stripped))).toMatch(/does not say what it showed/);
    // accept-all on a page that is out of date
    const all = page(s, "stories");
    all.q<HTMLInputElement>('[data-story="US-ORD-001"] [data-f=accept-story]').click();
    const accept = all.decisions();
    expect(plan(s, accept).conflicts).toEqual([]);
    const refused = plan(moved, accept);
    expect(refused.commands).toHaveLength(0);
    expect(reasons(refused)).toMatch(/accept-all is not applied from an out-of-date page/);
  });

  it("another tab's remark on the same item is never overwritten", () => {
    const s = withStories();
    const p = page(s, "stories");
    p.q<HTMLInputElement>('[data-key="step:0"] input[value=accepted]').click();
    p.q<HTMLInputElement>('[data-key="step:0"] [data-f=comment]').value = "tab B";
    const submission = p.decisions();
    const other = ok(s, { action: "review-stories", via: "html-review", items: [{ storyId: "US-ORD-001", revision: 1, key: "step:0", status: "accepted", comment: "tab A" }], acceptStories: [] }, LATER);
    const result = plan(other, submission);
    expect(result.commands).toHaveLength(0);
    expect(reasons(result)).toMatch(/remark changed since you opened this page/);
  });
});

describe("a saved or handed-over decisions file is held to the same rules", () => {
  it("a misspelt or extra key anywhere in the file is refused, never dropped (it could be a base value)", () => {
    const s = base();
    const p = page(s, "requirements");
    p.q<HTMLInputElement>('[data-ac="REQ-ORD-001-AC-01"] [data-f=ac-comment]').value = "x";
    const submission = p.decisions();
    submission.requirements.requirements[0].criteria[0].fromcomment = "typo";
    expect(() => plan(s, submission)).toThrow(/"fromcomment" is not a parameter/);
    expect(() => plan(s, { ...p.decisions(), approved: true })).toThrow(/"approved" is not a parameter/);
  });
});

describe("the accept / agree controls need a page that is still current", () => {
  it("requirements accept-all, plan agree and prototype accept are refused when a mark, remark or feedback changed after the page was opened", () => {
    // requirements: another tab reset a mark after the page was opened
    let s = ok(base(), { action: "review-requirements", via: "html-review", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-01", status: "accepted" }] }] });
    const p = page(s, "requirements");
    p.q<HTMLInputElement>("#accept-all").click();
    const accept = p.decisions();
    expect(plan(s, accept).commands.some((c) => c.action === "accept-requirements")).toBe(true);
    const reset = ok(s, { action: "review-requirements", via: "html-review", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-01", status: "pending", comment: "wait" }] }] }, LATER);
    const refused = plan(reset, accept);
    expect(refused.commands.some((c) => c.action === "accept-requirements")).toBe(false);
    expect(reasons(refused)).toMatch(/out of date.*reload the page/);
    // plan: a line was set to pending with a remark after the page was opened
    s = planned();
    const pp = page(s, "story-plan");
    pp.q<HTMLInputElement>("#agree-plan").click();
    const agree = pp.decisions();
    expect(plan(s, agree).commands.some((c) => c.action === "agree-story-plan")).toBe(true);
    const marked = ok(s, { action: "update-story-plan", via: "html-review", operations: [{ op: "review", id: "US-ORD-001", status: "pending", comment: "unclear" }] }, LATER);
    expect(plan(marked, agree).commands.some((c) => c.action === "agree-story-plan")).toBe(false);
  });
});
