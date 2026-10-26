import { describe, expect, it } from "vitest";
import {
  analyzeStoryCoverage,
  acceptanceStatus,
  applyWorkflowCommand,
  inferCapabilities,
  migrateWorkflowState,
  nextStep,
  phaseGates,
  reviewProgress,
  storyContentFingerprint,
  storyReviewProgress,
  WorkflowStateSchema,
  type WorkflowState,
} from "./index.js";
import { approvalFor } from "./human-act-testing.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const apply = (state: WorkflowState | null, command: Record<string, unknown>) => applyWorkflowCommand(state, command, { now: NOW, channel: { via: "html-review" } });
const ok = (state: WorkflowState, command: Record<string, unknown>) => apply(state, command).state;

function open(mode: "guided" | "classic" = "guided", changeKind?: string): WorkflowState {
  return apply(null, { action: "open", projectId: "orders", title: "Order list", request: "Managers see and manage orders", mode, ...(changeKind ? { changeKind } : {}) }).state;
}

function withRequirements(state = open()): WorkflowState {
  let s = ok(state, { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view, search and edit orders", acceptanceCriteria: ["The list shows all orders", "A manager can search by number", "A manager can edit an order status"] });
  s = ok(s, { action: "add-requirement", id: "REQ-ORD-002", statement: "Managers can export orders to CSV", acceptanceCriteria: ["Export contains the filtered rows"] });
  return s;
}

const accepted = (state: WorkflowState) => ok(state, { action: "accept-requirements", via: "html-review" });

function story(id: string, requirementIds: string[], narrative: string, extra: Record<string, unknown> = {}) {
  return {
    action: "add-story",
    id,
    requirementIds,
    actor: "manager",
    narrative,
    objective: "o",
    userValue: "v",
    happyPath: ["step one", "step two"],
    acceptanceCriteria: [{ id: `${id}-AC-01`, given: "g", when: "w", then: "t" }],
    expectedResults: ["done"],
    confirmedBehavior: false,
    ...extra,
  };
}

describe("requirements review: scope, per-criterion marks, point edits", () => {
  it("a new requirement has pending criteria and is in scope", () => {
    const s = withRequirements();
    expect(s.requirements[0].scope).toBe("in");
    expect(s.requirements[0].acceptanceCriteria.every((c) => c.review.status === "pending")).toBe(true);
    expect(reviewProgress(s)).toMatchObject({ criteria: 4, pending: 4, accepted: 0, complete: false });
  });

  it("marks each criterion separately and keeps the rest pending", () => {
    let s = withRequirements();
    s = ok(s, { action: "review-requirements", via: "html-review", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-01", status: "accepted" }, { id: "REQ-ORD-001-AC-02", status: "rejected", comment: "search by phone too" }] }] });
    const [a1, a2, a3] = s.requirements[0].acceptanceCriteria;
    expect([a1.review.status, a2.review.status, a3.review.status]).toEqual(["accepted", "rejected", "pending"]);
    expect(a2.review.comment).toBe("search by phone too");
    expect(a1.review.via).toBe("html-review");
    expect(reviewProgress(s)).toMatchObject({ accepted: 1, rejected: 1, pending: 2 });
  });

  it("editing a criterion bumps the requirement revision, resets that mark only and marks downstream stale", () => {
    let s = accepted(withRequirements());
    s = ok(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-02", statement: "A manager can search by number or phone" }] }] });
    const r = s.requirements[0];
    expect(r.revision).toBe(2);
    expect(r.acceptanceCriteria[1].statement).toMatch(/or phone/);
    expect(r.acceptanceCriteria[1].review.status).toBe("pending");
    expect(r.acceptanceCriteria[0].review.status).toBe("accepted");
    expect(acceptanceStatus(s, "requirements_review")).toBe("stale");
  });

  it("adds and removes criteria by id", () => {
    let s = withRequirements();
    s = ok(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", addAcceptance: [{ statement: "Export is limited to 10000 rows" }], removeAcceptance: ["REQ-ORD-002-AC-01"] }] });
    expect(s.requirements[1].acceptanceCriteria.map((c) => c.id)).toEqual(["REQ-ORD-002-AC-02"]);
    expect(() => apply(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", removeAcceptance: ["REQ-ORD-002-AC-99"] }] })).toThrow(/not an acceptance criterion/);
  });

  it("bulk acceptance records the acceptance bound to the reviewed content", () => {
    const s = accepted(withRequirements());
    expect(reviewProgress(s).complete).toBe(true);
    expect(acceptanceStatus(s, "requirements_review")).toBe("accepted");
    expect(s.phaseAcceptance.requirements_review.via).toBe("html-review");
  });

  it("taking a requirement out of scope removes it from what must be covered and reopens nothing else", () => {
    let s = withRequirements();
    s = ok(s, { action: "set-requirement-scope", requirementIds: ["REQ-ORD-002"], scope: "deferred", note: "too complex for this release" });
    expect(s.requirements[1].scope).toBe("deferred");
    expect(reviewProgress(s)).toMatchObject({ requirements: 1, deferred: 1, criteria: 3 });
    s = accepted(s);
    expect(reviewProgress(s).complete).toBe(true);
  });

  it("an out-of-scope requirement excludes its stories and its plan lines, and restoring the scope brings them back for re-review", () => {
    let s = accepted(withRequirements(open("classic")));
    s = ok(s, story("US-ORD-001", ["REQ-ORD-002"], "As a manager, I want to export orders, so that I can share them."));
    s = ok(s, { action: "set-story-plan", entries: [{ id: "US-ORD-001", title: "Export", implementation: "CSV export", userGets: "a file", requirementIds: ["REQ-ORD-002"] }] });
    s = ok(s, { action: "set-requirement-scope", requirementIds: ["REQ-ORD-002"], scope: "excluded" });
    expect(s.stories[0].status).toBe("excluded");
    expect(s.storyPlan!.entries[0].status).toBe("excluded");
    expect(s.storyHistory.some((h) => h.kind === "scope")).toBe(true);
    s = ok(s, { action: "set-requirement-scope", requirementIds: ["REQ-ORD-002"], scope: "in" });
    expect(s.stories[0].status).toBe("proposed");
    expect(s.stories[0].confirmedBehavior).toBe(false);
    expect(s.storyPlan!.entries[0].status).toBe("planned");
  });
});

describe("prototype", () => {
  const base = () => accepted(withRequirements());
  const prototype = {
    kind: "ui",
    title: "Orders",
    roles: ["manager", "viewer"],
    mock: [{ id: "orders", name: "Orders", fields: [{ key: "number", label: "Number" }, { key: "status", label: "Status", type: "enum", options: ["new", "paid"] }], rows: [{ number: "A-1", status: "new" }] }],
    screens: [
      {
        id: "list",
        title: "Order list",
        states: ["default", "loading", "empty", "error", "denied"],
        elements: [
          { id: "grid", kind: "table", collection: "orders", columns: ["number", "status"], requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-01"] },
          { id: "find", kind: "search", requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-02"] },
          { id: "open", kind: "button", label: "Edit", action: "navigate", navigatesTo: "edit", requirementIds: ["REQ-ORD-001"], allowedRoles: ["manager"] },
        ],
      },
      { id: "edit", title: "Edit order", elements: [{ id: "form", kind: "form", collection: "orders", requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-03"] }] },
    ],
  };

  it("stores a prototype linked to REQ and AC with revisions and history", () => {
    const s = ok(base(), { action: "set-prototype", prototype });
    expect(s.prototype).toMatchObject({ revision: 1, status: "draft", kind: "ui" });
    expect(s.prototype!.screens[0].elements[0].acIds).toEqual(["REQ-ORD-001-AC-01"]);
    expect(s.prototype!.history).toHaveLength(1);
  });

  it("rejects dangling links: unknown screen, collection, requirement and criterion", () => {
    const bad = (patch: (p: typeof prototype) => void) => {
      const copy = JSON.parse(JSON.stringify(prototype));
      patch(copy);
      return () => apply(base(), { action: "set-prototype", prototype: copy });
    };
    expect(bad((p) => (p.screens[0].elements[2].navigatesTo = "nowhere"))).toThrow(/unknown screen/);
    expect(bad((p) => (p.screens[0].elements[0].collection = "nope"))).toThrow(/unknown mock collection/);
    expect(bad((p) => (p.screens[0].elements[0].requirementIds = ["REQ-ORD-099"]))).toThrow(/unknown requirement/);
    expect(bad((p) => (p.screens[0].elements[0].acIds = ["REQ-ORD-001-AC-99"]))).toThrow(/unknown acceptance criterion/);
  });

  it("iterative edits keep earlier content and bump the revision; feedback is stored and resolvable", () => {
    let s = ok(base(), { action: "set-prototype", prototype });
    s = ok(s, { action: "update-prototype", operations: [{ op: "add-element", screenId: "list", element: { id: "delete", kind: "button", label: "Delete", action: "delete-row", intent: "delete", requirementIds: ["REQ-ORD-001"] } }, { op: "update-screen", id: "edit", patch: { title: "Edit order details" } }], summary: "add delete" });
    expect(s.prototype!.revision).toBe(2);
    expect(s.prototype!.screens[0].elements.map((e) => e.id)).toContain("delete");
    expect(s.prototype!.screens[1].title).toBe("Edit order details");
    s = ok(s, { action: "prototype-feedback", items: [{ target: "list#grid", comment: "add a total column" }] });
    expect(s.prototype!.feedback[0]).toMatchObject({ id: "FB-001", resolved: false });
    s = ok(s, { action: "prototype-feedback", resolve: ["FB-001"] });
    expect(s.prototype!.feedback[0].resolved).toBe(true);
    expect(() => apply(s, { action: "update-prototype", operations: [{ op: "remove-screen", id: "missing" }] })).toThrow(/unknown screen/);
  });

  it("a content change makes the acceptance stale, feedback does not", () => {
    let s = ok(base(), { action: "set-prototype", prototype });
    s = ok(s, { action: "accept-prototype", via: "html-review" });
    expect(acceptanceStatus(s, "prototype")).toBe("accepted");
    s = ok(s, { action: "prototype-feedback", items: [{ target: "list", comment: "looks fine" }] });
    expect(acceptanceStatus(s, "prototype")).toBe("accepted");
    s = ok(s, { action: "update-prototype", operations: [{ op: "set-meta", title: "Orders v2" }] });
    expect(acceptanceStatus(s, "prototype")).toBe("stale");
  });

  it("backend-only work uses an api prototype with request/response examples, not UI screens", () => {
    const s = ok(base(), {
      action: "set-prototype",
      prototype: { kind: "api", title: "Orders API", endpoints: [{ id: "list", method: "GET", path: "/orders", requirementIds: ["REQ-ORD-001"], responses: [{ status: 200, example: [{ number: "A-1" }] }, { status: 403, description: "denied" }] }] },
    });
    expect(s.prototype!.kind).toBe("api");
    expect(() => apply(base(), { action: "set-prototype", prototype: { kind: "api", title: "empty" } })).toThrow(/at least one endpoint/);
    expect(() => apply(base(), { action: "set-prototype", prototype: { kind: "ui", title: "empty" } })).toThrow(/at least one screen/);
  });

  it("removing an acceptance criterion drops it from prototype links", () => {
    let s = ok(base(), { action: "set-prototype", prototype });
    s = ok(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", removeAcceptance: ["REQ-ORD-001-AC-02"] }] });
    expect(s.prototype!.screens[0].elements[1].acIds).toEqual([]);
  });
});

describe("story plan and guided story creation", () => {
  const plan = (extra: Record<string, unknown>[] = []) => [
    { id: "US-ORD-001", title: "See orders", implementation: "Order list with paging", userGets: "a list of all orders", data: ["order rows"], requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-01"], capabilities: ["view"] },
    { id: "US-ORD-002", title: "Find an order", implementation: "Search box", userGets: "search by number", requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-02"], capabilities: ["search"], dependsOn: ["US-ORD-001"] },
    { id: "US-ORD-003", title: "Edit an order", implementation: "Edit form", userGets: "status editing", requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-03"], capabilities: ["edit"], dependsOn: ["US-ORD-001"] },
    { id: "US-ORD-004", title: "Export", implementation: "CSV export of the filtered rows", userGets: "a CSV file", requirementIds: ["REQ-ORD-002"], capabilities: ["view", "filter"] },
    ...extra,
  ];
  const planned = () => ok(accepted(withRequirements()), { action: "set-story-plan", entries: plan() });

  it("rejects detailed stories before the plan is agreed (guided)", () => {
    expect(() => apply(accepted(withRequirements()), story("US-ORD-001", ["REQ-ORD-001"], "As a manager, I want to see orders, so that I can work."))).toThrow(/story plan/);
    expect(() => apply(planned(), story("US-ORD-001", ["REQ-ORD-001"], "As a manager, I want to see orders, so that I can work."))).toThrow(/story plan/);
  });

  it("classic mode keeps the alpha.48 behaviour: stories without a plan", () => {
    const s = ok(accepted(withRequirements(open("classic"))), story("US-ORD-001", ["REQ-ORD-001"], "As a manager, I want to see orders, so that I can work."));
    expect(s.stories).toHaveLength(1);
  });

  it("validates plan references and dependency cycles", () => {
    const s = accepted(withRequirements());
    expect(() => apply(s, { action: "set-story-plan", entries: [{ ...plan()[0], requirementIds: ["REQ-ORD-099"] }] })).toThrow(/unknown requirement/);
    expect(() => apply(s, { action: "set-story-plan", entries: [{ ...plan()[0], dependsOn: ["US-ORD-002"] }, { ...plan()[1], dependsOn: ["US-ORD-001"] }] })).toThrow(/cycle|not in the plan/);
    expect(() => apply(s, { action: "set-story-plan", entries: [{ ...plan()[0], repositoryIds: ["web"] }] })).toThrow(/not registered/);
  });

  it("an agreed plan lets stories in, one per planned line, and marks the line detailed", () => {
    let s = ok(planned(), { action: "agree-story-plan", via: "html-review" });
    expect(acceptanceStatus(s, "story_plan")).toBe("accepted");
    s = ok(s, story("US-ORD-001", ["REQ-ORD-001"], "As a manager, I want to see orders, so that I can work."));
    expect(s.storyPlan!.entries[0].status).toBe("detailed");
    expect(() => apply(s, story("US-ORD-099", ["REQ-ORD-001"], "As a manager, I want an unplanned thing, so that I win."))).toThrow(/not a line of the agreed plan/);
  });

  it("editing the plan after agreement makes the agreement stale", () => {
    let s = ok(planned(), { action: "agree-story-plan" });
    s = ok(s, { action: "update-story-plan", operations: [{ op: "update", id: "US-ORD-004", patch: { title: "Export to CSV" } }] });
    expect(acceptanceStatus(s, "story_plan")).toBe("stale");
    expect(s.storyPlan!.status).toBe("draft");
  });

  it("a plan that only creates data is refused: the coverage check demands viewing, searching and states", () => {
    const createOnly = ok(accepted(withRequirements()), {
      action: "set-story-plan",
      entries: [
        { id: "US-ORD-001", title: "Add an order", implementation: "Create form", userGets: "new orders", requirementIds: ["REQ-ORD-001"], capabilities: ["create"] },
        { id: "US-ORD-002", title: "Edit an order", implementation: "Edit form", userGets: "edits", requirementIds: ["REQ-ORD-001"], capabilities: ["edit"] },
        { id: "US-ORD-003", title: "Export", implementation: "Export", userGets: "csv", requirementIds: ["REQ-ORD-002"], capabilities: ["create"] },
      ],
    });
    const report = analyzeStoryCoverage(createOnly);
    expect(report.ok).toBe(false);
    expect(report.gaps[0].missing).toContain("view");
    expect(() => apply(createOnly, { action: "agree-story-plan" })).toThrow(/does not cover/);
    const waived = ok(createOnly, { action: "waive-coverage", kind: "view", requirementId: "REQ-ORD-001", reason: "viewing ships with the next story set" });
    expect(analyzeStoryCoverage(waived).gaps.find((g) => g.requirementId === "REQ-ORD-001")?.missing ?? []).not.toContain("view");
  });

  it("derives expected capabilities from the prototype: roles imply permissions, screen states imply states", () => {
    const s = ok(accepted(withRequirements()), {
      action: "set-prototype",
      prototype: { kind: "ui", title: "x", mock: [{ id: "o", name: "o", fields: [{ key: "n", label: "n" }] }], screens: [{ id: "s", title: "S", states: ["default", "empty", "denied"], elements: [{ id: "t", kind: "table", collection: "o", requirementIds: ["REQ-ORD-001"], allowedRoles: ["manager"] }] }] },
    });
    const withPlan = ok(s, { action: "set-story-plan", entries: [{ id: "US-ORD-001", title: "See", implementation: "list", userGets: "list", requirementIds: ["REQ-ORD-001", "REQ-ORD-002"], capabilities: ["view"] }] });
    const missing = analyzeStoryCoverage(withPlan).gaps.find((g) => g.requirementId === "REQ-ORD-001")!.missing;
    expect(missing).toEqual(expect.arrayContaining(["permissions", "states"]));
  });

  it("infers capabilities from plain text so an untagged story is not invisible", () => {
    expect(inferCapabilities("The manager can search and filter orders and sees an error when the service is unavailable")).toEqual(expect.arrayContaining(["search", "filter", "error"]));
  });
});

describe("story editing, exclusion, split, merge, history and invalidation", () => {
  const withStories = () => {
    let s = accepted(withRequirements(open("classic")));
    s = ok(s, story("US-ORD-001", ["REQ-ORD-001"], "As a manager, I want to see orders, so that I can work.", { happyPath: ["open list", "scroll"], alternatives: ["empty list"] }));
    s = ok(s, story("US-ORD-002", ["REQ-ORD-002"], "As a manager, I want to export orders, so that I can share them."));
    return s;
  };

  it("edits one story by id: new revision, snapshot of the old one, confirmation and evidence invalidated", () => {
    let s = withStories();
    // confirm revision 1 (a human act needs the user's approval)
    const confirm = { action: "confirm-story", id: "US-ORD-001", revision: 1, contentFingerprint: storyContentFingerprint(s.stories[0]) };
    const approval = approvalFor(s, confirm);
    s = applyWorkflowCommand(s, confirm, { userApproval: approval.userApproval, now: NOW }).state;
    expect(s.stories[0].confirmedBehavior).toBe(true);
    s = {
      ...s,
      verdicts: [{ id: "V-1", scope: "requirement" as const, scopeId: "REQ-ORD-001", verdict: "PASS" as const, evidenceRefs: [], requirementIds: ["REQ-ORD-001" as const], stale: false }],
    };
    s = ok(s, { action: "update-story", id: "US-ORD-001", patch: { narrative: "As a manager, I want to browse orders, so that I can work." }, reason: "wording" });
    const edited = s.stories[0];
    expect(edited.revision).toBe(2);
    expect(edited.confirmedBehavior).toBe(false);
    expect(edited.status).toBe("proposed");
    expect(s.storyHistory.at(-1)).toMatchObject({ storyId: "US-ORD-001", revision: 1, kind: "edit" });
    expect(s.storyHistory.at(-1)!.previous.confirmedBehavior).toBe(true);
    expect(s.verdicts[0].stale).toBe(true);
    expect(s.stories[1].revision).toBe(1);
  });

  it("changes individual acceptance criteria and keeps review marks of untouched items", () => {
    let s = withStories();
    s = ok(s, { action: "review-stories", via: "html-review", items: [{ storyId: "US-ORD-001", revision: 1, key: "step:0", status: "accepted" }, { storyId: "US-ORD-001", revision: 1, key: "step:1", status: "accepted" }, { storyId: "US-ORD-001", revision: 1, key: "ac:US-ORD-001-AC-01", status: "accepted" }] });
    s = ok(s, { action: "update-story", id: "US-ORD-001", patch: { happyPath: ["open list", "scroll down"] }, criteria: [{ op: "add", given: "no orders", when: "the list opens", then: "an empty state is shown" }] });
    const e = s.stories[0];
    expect(e.review["step:0"].status).toBe("accepted");
    expect(e.review["step:1"]).toBeUndefined();
    expect(e.acceptanceCriteria.map((c) => c.id)).toEqual(["US-ORD-001-AC-01", "US-ORD-001-AC-02"]);
    expect(() => apply(s, { action: "update-story", id: "US-ORD-001", criteria: [{ op: "remove", id: "US-ORD-001-AC-01" }, { op: "remove", id: "US-ORD-001-AC-02" }] })).toThrow(/at least one acceptance criterion/);
  });

  it("excludes and restores a story, with the reason and history, and reports coverage", () => {
    let s = withStories();
    s = ok(s, { action: "exclude-story", id: "US-ORD-002", reason: "export moves to the next release" });
    expect(s.stories[1]).toMatchObject({ status: "excluded", excludedReason: "export moves to the next release" });
    expect(analyzeStoryCoverage(s).requirementsWithoutStories).toContain("REQ-ORD-002");
    s = ok(s, { action: "restore-story", id: "US-ORD-002" });
    expect(s.stories[1].status).toBe("proposed");
    expect(s.storyHistory.map((h) => h.kind)).toEqual(["exclude", "restore"]);
    expect(() => apply(s, { action: "restore-story", id: "US-ORD-001" })).toThrow(/not excluded/);
  });

  it("splits a story: every criterion is allocated exactly once and the original is superseded", () => {
    let s = withStories();
    s = ok(s, { action: "update-story", id: "US-ORD-001", criteria: [{ op: "add", given: "g2", when: "w2", then: "t2" }] });
    s = ok(s, {
      action: "split-story",
      id: "US-ORD-001",
      reason: "two separate user goals",
      into: [
        { id: "US-ORD-010", narrative: "As a manager, I want to see orders, so that I can work.", moveAcceptance: ["US-ORD-001-AC-01"] },
        { id: "US-ORD-011", narrative: "As a manager, I want to see an empty state, so that I know there are no orders.", moveAcceptance: ["US-ORD-001-AC-02"] },
      ],
    });
    expect(s.stories.find((x) => x.id === "US-ORD-001")!.status).toBe("superseded");
    expect(s.stories.filter((x) => x.id.startsWith("US-ORD-01")).map((x) => x.acceptanceCriteria.length)).toEqual([1, 1]);
    expect(() => apply(withStories(), { action: "split-story", id: "US-ORD-001", into: [{ id: "US-ORD-010", moveAcceptance: ["US-ORD-001-AC-01"] }, { id: "US-ORD-011", acceptanceCriteria: [{ given: "a", when: "b", then: "c" }] }] })).not.toThrow();
    expect(() => apply(withStories(), { action: "split-story", id: "US-ORD-001", into: [{ id: "US-ORD-010", acceptanceCriteria: [{ given: "a", when: "b", then: "c" }] }, { id: "US-ORD-011", acceptanceCriteria: [{ given: "a", when: "b", then: "c" }] }] })).toThrow(/not allocated/);
  });

  it("merges stories into one with the union of requirements and criteria", () => {
    const s = ok(withStories(), { action: "merge-stories", ids: ["US-ORD-001", "US-ORD-002"], into: { id: "US-ORD-020", narrative: "As a manager, I want to see and export orders, so that I can work and share." }, reason: "same screen" });
    const merged = s.stories.find((x) => x.id === "US-ORD-020")!;
    expect(merged.requirementIds).toEqual(["REQ-ORD-001", "REQ-ORD-002"]);
    expect(merged.acceptanceCriteria).toHaveLength(2);
    expect(new Set(merged.acceptanceCriteria.map((c) => c.id)).size).toBe(2);
    expect(s.stories.filter((x) => x.status === "superseded")).toHaveLength(2);
  });

  it("review progress counts every item and rejects stale revisions", () => {
    let s = withStories();
    const before = storyReviewProgress(s);
    expect(before.items).toBeGreaterThan(5);
    s = ok(s, { action: "review-stories", acceptStories: [{ storyId: "US-ORD-001", revision: 1 }, { storyId: "US-ORD-002", revision: 1 }] });
    expect(storyReviewProgress(s).complete).toBe(true);
    s = ok(s, { action: "update-story", id: "US-ORD-001", patch: { objective: "new objective" } });
    const result = apply(s, { action: "review-stories", items: [{ storyId: "US-ORD-001", revision: 1, key: "step:0", status: "rejected" }] }).result as { skipped: unknown[] };
    expect(result.skipped).toHaveLength(1);
  });

  it("accepting stories needs every item reviewed", () => {
    expect(() => apply(withStories(), { action: "accept-stories" })).toThrow(/not fully reviewed/);
  });
});

describe("repositories, contracts and change impact", () => {
  it("registers any number of repositories and links stories, requirements and services to them", () => {
    let s = accepted(withRequirements(open("classic")));
    for (const [id, role] of [["web", "web frontend"], ["ios", "iOS app"], ["android", "Android app"], ["api", "orders API"]]) {
      s = ok(s, { action: "register-repository", repository: { id, name: id, role, localPath: `/tmp/${id}` } });
    }
    expect(s.repositories).toHaveLength(4);
    s = ok(s, story("US-ORD-001", ["REQ-ORD-001"], "As a manager, I want to see orders, so that I can work."));
    s = ok(s, { action: "set-service", service: { id: "svc-api", name: "API", kind: "api", responsibilities: [], requirementIds: ["REQ-ORD-001"], dependsOn: [], status: "draft", repositoryId: "api" } });
    s = ok(s, { action: "assign-repositories", repositoryIds: ["web", "ios", "android"], storyIds: ["US-ORD-001"], requirementIds: ["REQ-ORD-001"] });
    expect(s.stories[0].repositoryIds).toEqual(["web", "ios", "android"]);
    expect(s.requirements[0].repositoryIds).toEqual(["web", "ios", "android"]);
    expect(() => apply(s, { action: "assign-repositories", repositoryIds: ["nope"], storyIds: ["US-ORD-001"] })).toThrow(/not registered/);
  });

  it("an inspection is a record of what was actually read; registering again is idempotent", () => {
    let s = ok(open("classic"), { action: "register-repository", repository: { id: "web", name: "Web", role: "frontend", localPath: "/tmp/web" } });
    const again = apply(s, { action: "register-repository", repository: { id: "web", name: "Web", role: "frontend", localPath: "/tmp/web" } });
    expect(again.duplicate).toBe(true);
    s = ok(s, { action: "record-repository-inspection", repositoryId: "web", inspection: { at: NOW.toISOString(), headSha: "abc1234", summary: "React app", frameworks: ["react"], entries: [{ path: "src/styles/tokens.css" }] } });
    expect(s.repositories[0]).toMatchObject({ status: "inspected", inspection: { headSha: "abc1234" } });
  });

  it("contracts name a provider and consumers that exist", () => {
    let s = ok(open("classic"), { action: "set-service", service: { id: "api", name: "API", kind: "api", responsibilities: [], requirementIds: [], dependsOn: [], status: "draft" } });
    s = ok(s, { action: "set-service", service: { id: "web", name: "Web", kind: "frontend", responsibilities: [], requirementIds: [], dependsOn: ["api"], status: "draft" } });
    s = ok(s, { action: "set-contract", contract: { id: "C-orders", name: "Orders list", providerServiceId: "api", consumerServiceIds: ["web"], description: "GET /orders" } });
    expect(s.contracts).toHaveLength(1);
    expect(() => apply(s, { action: "set-contract", contract: { id: "C-x", name: "x", providerServiceId: "ghost", consumerServiceIds: [] } })).toThrow(/not found/);
  });

  it("a change request must record the existing behaviour and impact before the prototype", () => {
    let s = accepted(withRequirements(open("guided", "change")));
    expect(phaseGates(s, "prototype")).toMatchObject({ ok: false });
    expect(phaseGates(s, "prototype").missing.join(" ")).toMatch(/impact/);
    s = ok(s, { action: "register-repository", repository: { id: "web", name: "Web", role: "frontend", localPath: "/tmp/web" } });
    s = ok(s, {
      action: "record-impact",
      impact: { baseline: { summary: "The list shows 20 orders per page", behaviors: [{ id: "B-1", statement: "Paging works", evidence: [{ repositoryId: "web", path: "src/orders/List.tsx" }] }] }, affected: [{ repositoryId: "web", area: "order list", change: "add search" }], regressionChecks: [{ id: "R-1", statement: "Paging still works", requirementIds: ["REQ-ORD-001"] }] },
    });
    expect(phaseGates(s, "prototype").ok).toBe(true);
    expect(() => apply(s, { action: "record-impact", impact: { baseline: { summary: "x" }, affected: [{ repositoryId: "ghost", area: "a", change: "c" }], regressionChecks: [] } })).toThrow(/not registered/);
  });
});

describe("phases, gates and returning to an earlier stage", () => {
  it("guided mode enforces the gates in order and does not let a jump skip one", () => {
    let s = withRequirements();
    expect(() => apply(s, { action: "advance-phase", to: "prototype" })).toThrow(/requirements accepted/);
    s = ok(s, { action: "advance-phase", to: "requirements_review" });
    s = accepted(s);
    s = ok(s, { action: "advance-phase", to: "prototype" });
    expect(s.phase).toBe("prototype");
    expect(() => apply(s, { action: "advance-phase", to: "stories_review" })).toThrow(/story_plan needs/);
    expect(() => apply(s, { action: "advance-phase", to: "request" })).toThrow(/use return-to-phase/);
  });

  it("classic mode reports the gates but does not block", () => {
    const s = withRequirements(open("classic"));
    const result = apply(s, { action: "advance-phase", to: "prototype" });
    expect(result.state.phase).toBe("prototype");
    expect((result.result as { gatesMissing: unknown[]; enforced: boolean }).enforced).toBe(false);
    expect((result.result as { gatesMissing: unknown[] }).gatesMissing.length).toBeGreaterThan(0);
  });

  it("returning to requirements invalidates later acceptances and leaves a trace", () => {
    let s = accepted(withRequirements());
    s = ok(s, { action: "advance-phase", to: "requirements_review" });
    s = ok(s, { action: "advance-phase", to: "prototype" });
    s = ok(s, { action: "set-prototype", prototype: { kind: "api", title: "API", endpoints: [{ id: "e", method: "GET", path: "/orders" }] } });
    s = ok(s, { action: "accept-prototype" });
    s = ok(s, { action: "return-to-phase", to: "requirements", reason: "the manager wants a new filter" });
    expect(s.phase).toBe("requirements");
    expect(s.phaseAcceptance.prototype).toBeUndefined();
    expect(s.phaseAcceptance.requirements_review).toBeUndefined();
    expect(s.phaseHistory.at(-1)).toMatchObject({ kind: "return", from: "prototype", to: "requirements" });
    expect(s.phaseHistory.at(-1)!.invalidated).toEqual(expect.arrayContaining(["prototype", "requirements_review"]));
    expect(s.sessionLog.at(-1)!.summary).toMatch(/returned to requirements/);
  });

  it("next step is deterministic and follows the stage", () => {
    const s = withRequirements();
    expect(nextStep(s)).toEqual(nextStep(s));
    expect(nextStep(s).phase).toBe("request");
    const review = ok(s, { action: "advance-phase", to: "requirements_review" });
    expect(nextStep(review)).toMatchObject({ action: "review-requirements", userDecision: true, tools: expect.arrayContaining(["praxis_review_render"]) });
    expect(nextStep(accepted(review))).toMatchObject({ action: "advance-to-prototype" });
  });

  it("records session notes with a next action, bounded in size", () => {
    let s = open();
    for (let i = 0; i < 205; i += 1) s = ok(s, { action: "log-session", summary: `note ${i}`, nextAction: "continue" });
    expect(s.sessionLog).toHaveLength(200);
    expect(s.sessionLog.at(-1)!.summary).toBe("note 204");
  });
});

describe("migration from contract 1.0.0 (alpha.48)", () => {
  /** A state exactly as alpha.48 wrote it: none of the 1.1.0 fields. */
  const alpha48 = () => {
    let s = accepted(withRequirements(open("classic")));
    s = ok(s, story("US-ORD-001", ["REQ-ORD-001"], "As a manager, I want to see orders, so that I can work."));
    const raw = JSON.parse(JSON.stringify(s));
    for (const key of ["mode", "phase", "phaseAcceptance", "phaseHistory", "repositories", "contracts", "impact", "prototype", "storyPlan", "storyHistory", "sessionLog", "waivers", "updatedAt"]) delete raw[key];
    delete raw.workItem.kind;
    raw.version = "1.0.0";
    for (const r of raw.requirements) {
      delete r.scope;
      delete r.repositoryIds;
      for (const c of r.acceptanceCriteria) delete c.review;
    }
    for (const st of raw.stories) for (const key of ["capabilities", "screenRefs", "repositoryIds", "review"]) delete st[key];
    return raw;
  };

  it("loads a 1.0.0 state unchanged and keeps every id, revision, story and decision", () => {
    const raw = alpha48();
    const parsed = WorkflowStateSchema.parse(raw);
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.requirements.map((r) => r.id)).toEqual(["REQ-ORD-001", "REQ-ORD-002"]);
    expect(parsed.stories[0].id).toBe("US-ORD-001");
    expect(parsed.workItem.kind).toBe("feature");
    expect(parsed.mode).toBe("classic");
    const migrated = migrateWorkflowState(parsed);
    expect(migrated.version).toBe("1.1.0");
    expect(migrated.workItem.id).toBe(parsed.workItem.id);
    expect(migrated.workItem.revision).toBe(parsed.workItem.revision);
    expect(migrated.stories).toEqual(parsed.stories);
    expect(migrated.phase).toBe("stories_review");
  });

  it("requirements approved in alpha.48 stay accepted, so the user is not asked to review again", () => {
    const raw = alpha48();
    raw.requirements[0].status = "approved";
    raw.requirements[1].status = "proposed";
    const migrated = migrateWorkflowState(WorkflowStateSchema.parse(raw));
    expect(migrated.requirements[0].acceptanceCriteria.every((c) => c.review.status === "accepted")).toBe(true);
    expect(migrated.requirements[1].acceptanceCriteria[0].review.status).toBe("pending");
  });

  it("migrating twice changes nothing, and new commands work on a migrated state", () => {
    const once = migrateWorkflowState(WorkflowStateSchema.parse(alpha48()));
    expect(migrateWorkflowState(once)).toBe(once);
    const next = ok(once, { action: "register-repository", repository: { id: "web", name: "Web", role: "frontend" } });
    expect(next.repositories).toHaveLength(1);
  });
});

describe("add-story keeps what it is given and what the plan said", () => {
  it("stores title, capabilities, screens and repositories, and inherits them from the agreed plan line", () => {
    let s = ok(open(), { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view and search orders", acceptanceCriteria: ["The list shows all orders", "A manager can search by number"] });
    s = accepted(s);
    s = ok(s, { action: "set-story-plan", entries: [{ id: "US-ORD-001", title: "View and search", implementation: "list page", userGets: "orders", requirementIds: ["REQ-ORD-001"], capabilities: ["view", "search", "states"], screenRefs: ["list"], repositoryIds: [] }] });
    s = ok(s, { action: "agree-story-plan", via: "html-review" });
    s = ok(s, story("US-ORD-001", ["REQ-ORD-001"], "As a manager, I want to see orders, so that I can work."));
    const detailed = s.stories[0];
    expect(detailed.title).toBe("View and search");
    expect(detailed.capabilities).toEqual(["view", "search", "states"]);
    expect(detailed.screenRefs).toEqual(["list"]);
    const explicit = ok(accepted(withRequirements(open("classic"))), story("US-ORD-009", ["REQ-ORD-001"], "As a manager, I want x, so that y.", { title: "Mine", capabilities: ["edit", "permissions"], screenRefs: ["detail#status"], repositoryIds: [] }));
    expect(explicit.stories[0]).toMatchObject({ title: "Mine", capabilities: ["edit", "permissions"], screenRefs: ["detail#status"] });
  });
});
