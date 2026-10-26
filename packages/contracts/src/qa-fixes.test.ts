// @vitest-environment node
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import { acceptanceStatus, applyWorkflowCommand, phaseGates, redactState, renderReview, submissionToCommands, WorkflowStateSchema, type WorkflowState } from "./index.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const U = { via: "html-review" as const };
const run = (s: WorkflowState | null, c: Record<string, unknown>, channel?: typeof U) => applyWorkflowCommand(s, c, { now: NOW, ...(channel ? { channel } : {}) }).state;
beforeAll(() => {
  process.env.PRAXIS_TEST_APPROVALS = "1";
});

const base = (mode: "guided" | "classic" = "guided") => {
  let s = run(null, { action: "open", projectId: "p", title: "Orders", request: "r", mode }, { via: "html-review" });
  s = run(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "View orders", acceptanceCriteria: ["List shows orders", "Search works"] });
  return s;
};
const submission = (s: WorkflowState, view: string, rest: Record<string, unknown>, fp: string) => ({ contract: "praxis.review.submission", version: 1, reviewId: "r", view, workItemId: s.workItem.id, baseFingerprint: fp, ...rest });

describe("review fixes", () => {
  it("D06: the user marking every criterion is the acceptance of the review", () => {
    let s = base();
    s = run(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-01", status: "accepted" }, { id: "REQ-ORD-001-AC-02", status: "accepted" }] }] }, U);
    expect(acceptanceStatus(s, "requirements_review")).toBe("accepted");
    expect(s.requirements[0].status).toBe("approved");
  });

  it("D05: only the user waives a gap", () => {
    const s = base();
    expect(() => run(s, { action: "waive-coverage", kind: "prototype", reason: "agent says so" })).toThrow(/cannot come from the agent/);
    expect(run(s, { action: "waive-coverage", kind: "prototype", reason: "pure refactor, nothing to show" }, U).waivers.length).toBe(1);
  });

  it("D03/D14/D27: stale agree is skipped, repeats are no-ops, a changed mark is a conflict", async () => {
    const { requirementsFingerprint, storyPlanFingerprint } = await import("./index.js");
    let s = base();
    const fp = requirementsFingerprint(s);
    const mark = (from: string, status: string) => ({ requirements: { requirements: [{ id: "REQ-ORD-001", revision: 1, criteria: [{ id: "REQ-ORD-001-AC-01", revision: 1, from, status }], addCriteria: [], removeCriteria: [] }], acceptAll: false } });
    const first = submissionToCommands(s, submission(s, "requirements", mark("pending", "accepted"), fp));
    expect(first.commands.length).toBe(1);
    expect(first.details[0]).toMatch(/REQ-ORD-001-AC-01 'List shows orders': ACCEPTED/);
    s = run(s, first.commands[0], U);
    const again = submissionToCommands(s, submission(s, "requirements", mark("pending", "accepted"), requirementsFingerprint(s)));
    expect(again.commands).toEqual([]);
    const other = submissionToCommands(s, submission(s, "requirements", mark("pending", "rejected"), requirementsFingerprint(s)));
    expect(other.conflicts[0].reason).toMatch(/already marked accepted/);
    // plan
    s = run(s, { action: "set-story-plan", entries: [{ id: "US-ORD-001", title: "T", implementation: "i", userGets: "u", requirementIds: ["REQ-ORD-001"], capabilities: ["view", "search", "states"] }] });
    const planFp = storyPlanFingerprint(s.storyPlan);
    s = run(s, { action: "update-story-plan", operations: [{ op: "update", id: "US-ORD-001", patch: { title: "Changed" } }] });
    const stale = submissionToCommands(s, submission(s, "story-plan", { plan: { entries: [], agree: true } }, planFp));
    expect(stale.commands).toEqual([]);
    expect(stale.conflicts[0].item).toBe("agree plan");
  });

  it("D15: a revision keeps what it replaced", () => {
    let s = base();
    s = run(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", statement: "View and filter orders" }] });
    const h = s.artifactHistory.find((x) => x.kind === "requirement")!;
    expect(JSON.parse(h.snapshot).statement).toBe("View orders");
    expect(h.revision).toBe(1);
  });

  it("D09: prototype data with password-like names survives storage; a real-looking secret is refused", () => {
    let s = base();
    s = run(s, { action: "accept-requirements" }, U);
    s = run(s, { action: "set-prototype", prototype: { kind: "api", title: "API", endpoints: [{ id: "login", method: "POST", path: "/login", request: { password: "hunter2", Authorization: "Bearer abc" }, responses: [{ status: 200, example: { next_token: "page-2", cursor: "a-very-long-slug-that-has-more-than-forty-characters-in-it-1234" } }] }] } });
    const stored = JSON.parse(JSON.stringify(redactState(s)));
    expect(JSON.stringify(stored.prototype)).not.toContain("[redacted]");
    expect(WorkflowStateSchema.parse(stored).prototype!.endpoints[0].request).toEqual({ password: "hunter2", Authorization: "Bearer abc" });
    expect(() => run(s, { action: "update-prototype", operations: [{ op: "set-endpoint", endpoint: { id: "x", method: "GET", path: "/x", request: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz123456" }, responses: [] } }] })).toThrow(/real secret/);
  });

  it("D07/D19/D18/D08: records need a service, services need registered repositories, cycles and unfinished services block", () => {
    let s = base();
    expect(() => run(s, { action: "record-implementation", id: "I1", serviceId: "ghost", requirementIds: ["REQ-ORD-001"], path: "a.js", summary: "x" })).toThrow(/not part of this work item/);
    const svc = (id: string, deps: string[], extra: Record<string, unknown> = {}) => ({ action: "set-service", service: { id, name: id, kind: "module", responsibilities: ["x"], requirementIds: ["REQ-ORD-001"], dependsOn: deps, status: "in_progress", ...extra } });
    expect(() => run(s, svc("a", [], { repositoryId: "nope" }))).toThrow(/not registered/);
    s = run(s, svc("a", ["b"]));
    s = run(s, svc("b", ["a"]));
    expect(phaseGates(s, "development").missing.join(" ")).toMatch(/cycle/);
    let t = run(base("classic"), svc("a", []));
    t = run(t, svc("b", []));
    t = run(t, { action: "record-implementation", id: "I1", serviceId: "a", requirementIds: ["REQ-ORD-001"], path: "a.js", summary: "x" });
    t = { ...t, verdicts: [{ id: "V1", scope: "feature", scopeId: t.workItem.id, verdict: "PASS", evidenceRefs: ["x"], requirementIds: ["REQ-ORD-001"], stale: false } as never] };
    const missing = phaseGates(t, "delivery").missing.join(" ");
    expect(missing).toMatch(/service b has no current implementation record/);
    expect(missing).toMatch(/service a has no current non-FAIL verdict/);
  });
});

describe("prototype search box (D12)", () => {
  it("takes more than one character and keeps its value and focus", async () => {
    let s = base();
    s = run(s, { action: "accept-requirements" }, U);
    s = run(s, { action: "set-prototype", prototype: { kind: "ui", title: "P", startScreen: "l", mock: [{ id: "o", name: "O", fields: [{ key: "n", label: "N", type: "string" }], rows: [{ n: "A-1" }, { n: "B-2" }] }], screens: [{ id: "l", title: "L", elements: [{ id: "s", kind: "search", collection: "o" }, { id: "t", kind: "table", collection: "o", columns: ["n"] }] }] } });
    const dom = new JSDOM(renderReview(s, "prototype"), { runScripts: "dangerously", pretendToBeVisual: true });
    const doc = dom.window.document;
    const box = () => doc.querySelector("input[data-search]") as HTMLInputElement;
    const original = box();
    for (const text of ["B", "B-", "B-2"]) {
      box().value = text;
      box().dispatchEvent(new dom.window.Event("input"));
    }
    expect(box().value).toBe("B-2");
    expect(doc.querySelectorAll("#proto-screen tr").length).toBe(2);
    expect(box()).toBe(original); // the input itself is never rebuilt, so focus and caret stay in a real browser
  });
});

import { commandCatalog, WorkflowCommandSchema } from "./index.js";
describe("command catalog (D11)", () => {
  it("lists every action with required fields, and every example is a valid command", () => {
    const all = commandCatalog();
    expect(all.length).toBe(WorkflowCommandSchema.options.length);
    expect(all.find((c) => c.action === "record-implementation")!.required).toEqual(expect.arrayContaining(["id", "serviceId", "path", "summary"]));
    expect(all.find((c) => c.action === "accept-requirements")!.userOnly).toBe(true);
    for (const c of all.filter((x) => x.example)) expect(() => WorkflowCommandSchema.parse(c.example), c.action).not.toThrow();
  });
});
