// @vitest-environment node
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import { applyWorkflowCommand, migrateWorkflowState, openLocalWorkflow, phaseGates, renderReview, submissionToCommands, workStateStamp, WorkflowStateSchema, type WorkflowState } from "./index.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const U = { via: "html-review" as const };
const run = (s: WorkflowState | null, c: Record<string, unknown>, channel?: typeof U) => applyWorkflowCommand(s, c, { now: NOW, ...(channel ? { channel } : {}) }).state;
beforeAll(() => {
  process.env.PRAXIS_TEST_APPROVALS = "1";
});

describe("default mode and switching", () => {
  it("a new work item is guided, an explicit mode is respected, and an alpha.48 item stays classic", () => {
    expect(openLocalWorkflow({ projectId: "p", title: "t", request: "r" }).mode).toBe("guided");
    expect(openLocalWorkflow({ projectId: "p", title: "t", request: "r", mode: "classic" }).mode).toBe("classic");
    const old = JSON.parse(JSON.stringify(openLocalWorkflow({ projectId: "p", title: "t", request: "r" })));
    for (const key of ["mode", "phase", "phaseAcceptance", "phaseHistory", "repositories", "contracts", "prototype", "storyPlan", "storyHistory", "sessionLog", "waivers", "artifactHistory", "updatedAt"]) delete old[key];
    old.version = "1.0.0";
    const migrated = migrateWorkflowState(WorkflowStateSchema.parse(old));
    expect(migrated.mode).toBe("classic");
  });

  const classicItem = () => {
    let s = run(null, { action: "open", projectId: "p", title: "Orders", request: "r", mode: "classic" }, U);
    s = run(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "View orders", acceptanceCriteria: ["List shows orders"] });
    s = run(s, { action: "add-story", id: "US-ORD-001", requirementIds: ["REQ-ORD-001"], actor: "m", narrative: "As a m, I want orders, so that I see them.", objective: "o", userValue: "v", happyPath: ["a"], acceptanceCriteria: [{ id: "US-ORD-001-AC-01", given: "g", when: "w", then: "t" }], expectedResults: ["r"], confirmedBehavior: false });
    return s;
  };

  it("classic -> guided by the agent keeps every record, reports what it means, and the gates then apply", () => {
    const before = classicItem();
    const res = applyWorkflowCommand(before, { action: "set-mode", mode: "guided", reason: "use the new flow" }, { now: NOW });
    const after = res.state;
    expect(after.mode).toBe("guided");
    const strip = (s: WorkflowState) => { const { mode: _m, sessionLog: _l, updatedAt: _u, workItem: _w, history: _h, ...rest } = s as never as Record<string, unknown>; return rest; };
    expect(JSON.stringify(strip(after))).toBe(JSON.stringify(strip(before)));
    const report = (res.result as { report: Record<string, unknown> }).report;
    expect(report.storiesWithoutPlanLine).toEqual(["US-ORD-001"]);
    expect(report.stagesWithoutUserAcceptance).toEqual(expect.arrayContaining(["requirements_review"]));
    expect((report.dataKept as { stories: number }).stories).toBe(1);
    expect(after.sessionLog.at(-1)?.summary).toMatch(/classic to guided/);
    expect(() => run(after, { action: "add-story", id: "US-ORD-002", requirementIds: ["REQ-ORD-001"], actor: "m", narrative: "As a m, I want x, so that y.", objective: "o", userValue: "v", happyPath: ["a"], acceptanceCriteria: [{ id: "US-ORD-002-AC-01", given: "g", when: "w", then: "t" }], expectedResults: ["r"], confirmedBehavior: false })).toThrow(/story plan/);
    expect(WorkflowStateSchema.parse(JSON.parse(JSON.stringify(after))).stories.length).toBe(1);
  });

  it("guided -> classic switches the gates off, so only the user can do it", () => {
    const guided = run(classicItem(), { action: "set-mode", mode: "guided" });
    expect(() => run(guided, { action: "set-mode", mode: "classic" })).toThrow(/cannot come from the agent/);
    const back = run(guided, { action: "set-mode", mode: "classic", reason: "I prefer the old flow" }, U);
    expect(back.mode).toBe("classic");
    expect(back.stories.length).toBe(1);
  });

  it("switching to the mode the item is already in changes nothing", () => {
    const s = classicItem();
    const res = applyWorkflowCommand(s, { action: "set-mode", mode: "classic" }, { now: NOW, channel: U });
    expect(res.duplicate).toBe(true);
    expect(res.state).toBe(s);
  });

  it("the user switches mode from a review submission, and the dialog line says what stops being enforced", () => {
    const guided = run(classicItem(), { action: "set-mode", mode: "guided" });
    const plan = submissionToCommands(guided, { contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: guided.workItem.id, baseFingerprint: "x", baseState: workStateStamp(guided), modeChange: { to: "classic", reason: "no" } });
    expect(plan.commands).toEqual([{ action: "set-mode", via: "html-review", mode: "classic", reason: "no" }]);
    expect(plan.details[0]).toMatch(/gates, plan-before-stories and coverage checks stop being enforced/);
  });
});

describe("a contract is agreed by the user", () => {
  const withContract = (extra: Record<string, unknown> = {}) => {
    let s = run(null, { action: "open", projectId: "p", title: "Orders", request: "r", mode: "guided" });
    s = run(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "View orders", acceptanceCriteria: ["List shows orders"] });
    const svc = (id: string, deps: string[]) => ({ action: "set-service", service: { id, name: id, kind: "module", responsibilities: ["x"], requirementIds: ["REQ-ORD-001"], dependsOn: deps, status: "in_progress" } });
    s = run(s, svc("svc-api", []));
    s = run(s, svc("svc-web", ["svc-api"]));
    return run(s, { action: "set-contract", contract: { id: "C-1", name: "Orders API", providerServiceId: "svc-api", consumerServiceIds: ["svc-web"], schemaRef: "openapi.json", ...extra } });
  };

  it("an agent can propose a contract but is refused when it records one as agreed", () => {
    const s = withContract();
    expect(s.contracts[0].status).toBe("proposed");
    expect(() => run(s, { action: "set-contract", contract: { ...s.contracts[0], status: "agreed" } })).toThrow(/cannot come from the agent/);
    expect(() => withContract({ status: "agreed" })).toThrow(/cannot come from the agent/);
    expect(s.contracts[0].agreement).toBeUndefined();
  });

  it("the development gate waits for the user's agreement", () => {
    const s = withContract();
    expect(phaseGates(s, "development").missing.join(" ")).toMatch(/contract C-1 \(Orders API\) is not agreed by the user/);
    const agreed = run(s, { action: "set-contract", contract: { ...s.contracts[0], status: "agreed" } }, U);
    expect(agreed.contracts[0]).toMatchObject({ status: "agreed", agreement: { via: "html-review" } });
    expect(phaseGates(agreed, "development").missing.join(" ")).not.toMatch(/contract C-1/);
  });

  it("changing an agreed contract makes it proposed again; re-sending the same content keeps the agreement", () => {
    const agreed = run(withContract(), { action: "set-contract", contract: { ...withContract().contracts[0], status: "agreed" } }, U);
    const same = run(agreed, { action: "set-contract", contract: { ...agreed.contracts[0], status: "proposed" } });
    expect(same.contracts[0].status).toBe("agreed");
    const changed = run(agreed, { action: "set-contract", contract: { ...agreed.contracts[0], schemaRef: "openapi-v2.json", status: "proposed" } });
    expect(changed.contracts[0].status).toBe("proposed");
    expect(changed.contracts[0].agreement).toBeUndefined();
  });

  it("the contracts review page: the user ticks Agree and Saves; the agent cannot, and a stale page agrees nothing", () => {
    const s = withContract();
    const dom = new JSDOM(renderReview(s, "contracts"), { runScripts: "dangerously", pretendToBeVisual: true });
    const doc = dom.window.document;
    (doc.querySelector('[data-contract="C-1"] [data-f=agree]') as HTMLInputElement).click();
    (doc.querySelector("#btn-copy") as HTMLElement).click();
    const submission = JSON.parse((doc.querySelector("#out textarea") as HTMLTextAreaElement).value);
    expect(submission.view).toBe("contracts");
    expect(submission.contracts).toEqual({ agree: ["C-1"], remove: [] });
    const plan = submissionToCommands(s, submission);
    expect(plan.details[0]).toMatch(/AGREE contract C-1 'Orders API': provider svc-api, consumers svc-web, schema openapi.json/);
    let after = s;
    for (const command of plan.commands) after = run(after, command, U);
    expect(after.contracts[0].status).toBe("agreed");
    for (const command of plan.commands) expect(() => run(s, command)).toThrow(/cannot come from the agent/);
    // stale: the contract changed after the page was rendered
    const moved = run(s, { action: "set-contract", contract: { ...s.contracts[0], schemaRef: "other.json" } });
    const stale = submissionToCommands(moved, submission);
    expect(stale.commands).toEqual([]);
    expect(stale.conflicts[0].reason).toMatch(/changed since the page was rendered/);
  });
});

describe("what the user agreed cannot be dropped or left behind by the agent", () => {
  const agreedItem = () => {
    let s = run(null, { action: "open", projectId: "p", title: "Orders", request: "r" });
    s = run(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "View orders", acceptanceCriteria: ["List shows orders"] });
    const svc = (id: string, deps: string[]) => ({ action: "set-service", service: { id, name: id, kind: "module", responsibilities: ["x"], requirementIds: ["REQ-ORD-001"], dependsOn: deps, status: "in_progress" } });
    s = run(s, svc("svc-api", []));
    s = run(s, svc("svc-web", ["svc-api"]));
    s = run(s, { action: "set-contract", contract: { id: "C-1", name: "Orders API", providerServiceId: "svc-api", consumerServiceIds: ["svc-web"] } });
    return run(s, { action: "set-contract", contract: { ...s.contracts[0], status: "agreed" } }, U);
  };
  it("S5: the agent cannot remove an agreed contract; it can remove a proposed one; the user can remove either through the page", () => {
    const s = agreedItem();
    expect(() => run(s, { action: "remove-contract", id: "C-1" })).toThrow(/agreed by the user/);
    expect(run(s, { action: "remove-contract", id: "C-1" }, U).contracts).toEqual([]);
    const never = run(s, { action: "set-contract", contract: { id: "C-9", name: "never agreed", providerServiceId: "svc-api", consumerServiceIds: ["svc-web"] } });
    expect(run(never, { action: "remove-contract", id: "C-9" }).contracts.map((c) => c.id)).toEqual(["C-1"]);
    const plan = submissionToCommands(s, { contract: "praxis.review.submission", version: 1, reviewId: "r", view: "contracts", workItemId: s.workItem.id, baseFingerprint: contractsFp(s), contracts: { agree: [], remove: ["C-1"] } });
    expect(plan.commands).toEqual([{ action: "remove-contract", via: "html-review", id: "C-1" }]);
    expect(plan.details[0]).toMatch(/REMOVE contract C-1/);
  });
  it("S7: a contract that became proposed again after the gate was passed blocks quality and delivery", () => {
    const s = agreedItem();
    const changed = run(s, { action: "set-contract", contract: { ...s.contracts[0], schemaRef: "v2.json", status: "proposed" } });
    for (const phase of ["development", "quality", "delivery"] as const) expect(phaseGates(changed, phase).missing.join(" "), phase).toMatch(/contract C-1/);
    for (const phase of ["development", "quality", "delivery"] as const) expect(phaseGates(s, phase).missing.join(" "), phase).not.toMatch(/contract C-1/);
  });
  it("S8: the agreement line shows everything that is part of the agreed content", () => {
    let s = agreedItem();
    s = run(s, { action: "set-contract", contract: { ...s.contracts[0], description: "GET /orders returns {items: []}", requirementIds: ["REQ-ORD-001"], storyIds: [], status: "proposed" } });
    const plan = submissionToCommands(s, { contract: "praxis.review.submission", version: 1, reviewId: "r", view: "contracts", workItemId: s.workItem.id, baseFingerprint: contractsFp(s), contracts: { agree: ["C-1"], remove: [] } });
    expect(plan.details[0]).toMatch(/description 'GET \/orders returns \{items: \[\]\}', requirements REQ-ORD-001/);
  });
});
import { contractsFingerprint as contractsFp } from "./index.js";

describe("N1: an agreed contract cannot be laundered away by changing it first", () => {
  it("after the agent changes an agreed contract it is proposed again but still cannot be removed by the agent", () => {
    const base = (() => {
      let s = run(null, { action: "open", projectId: "p", title: "Orders", request: "r" });
      s = run(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "View orders", acceptanceCriteria: ["List shows orders"] });
      const svc = (id: string, deps: string[]) => ({ action: "set-service", service: { id, name: id, kind: "module", responsibilities: ["x"], requirementIds: ["REQ-ORD-001"], dependsOn: deps, status: "in_progress" } });
      s = run(s, svc("a", []));
      s = run(s, svc("b", ["a"]));
      s = run(s, { action: "set-contract", contract: { id: "C-1", name: "c", providerServiceId: "a", consumerServiceIds: ["b"] } });
      return run(s, { action: "set-contract", contract: { ...s.contracts[0], status: "agreed" } }, U);
    })();
    const reproposed = run(base, { action: "set-contract", contract: { ...base.contracts[0], schemaRef: "v2.json", status: "proposed" } });
    expect(reproposed.contracts[0]).toMatchObject({ status: "proposed", everAgreed: true });
    expect(() => run(reproposed, { action: "remove-contract", id: "C-1" })).toThrow(/agreed by the user/);
    expect(run(reproposed, { action: "remove-contract", id: "C-1" }, U).contracts).toEqual([]);
    // a contract the user never agreed stays removable by the agent
    const fresh = run(base, { action: "set-contract", contract: { id: "C-2", name: "d", providerServiceId: "a", consumerServiceIds: ["b"], status: "proposed" } });
    expect(run(fresh, { action: "remove-contract", id: "C-2" }).contracts.map((c) => c.id)).toEqual(["C-1"]);
  });
  it("the open result says when an item is classic", () => {
    const res = applyWorkflowCommand(null, { action: "open", projectId: "p", title: "t", request: "r", mode: "classic" }, { now: NOW, channel: U });
    expect((res.result as { note?: string }).note).toMatch(/classic/);
    expect((applyWorkflowCommand(null, { action: "open", projectId: "p", title: "t", request: "r" }, { now: NOW }).result as { mode: string }).mode).toBe("guided");
  });
});

import { createUserApproval, reviewApprovalRequest, workItemIdFor } from "./index.js";

describe("opening a work item in classic mode is the user's choice", () => {
  const open = { action: "open", projectId: "p", title: "Orders", request: "r", mode: "classic" };
  it("an agent cannot open a classic work item; without a mode it gets guided", () => {
    expect(() => applyWorkflowCommand(null, open, { now: NOW })).toThrow(/classic mode turns the stage gates off/);
    expect(applyWorkflowCommand(null, { ...open, mode: undefined }, { now: NOW }).state.mode).toBe("guided");
    expect(applyWorkflowCommand(null, { ...open, mode: "guided" }, { now: NOW }).state.mode).toBe("guided");
  });
  it("the user's approved batch opens it, even though the store adds a sequence number afterwards; an approval for another item does not", () => {
    const batch = [open];
    const approval = createUserApproval({ request: reviewApprovalRequest(batch, "Open in classic mode"), channel: "test" });
    const res = applyWorkflowCommand(null, { ...open, sequence: 1 }, { now: NOW, channel: { via: "approved", approval, batch } });
    expect(res.state.mode).toBe("classic");
    const other = createUserApproval({ request: reviewApprovalRequest([{ ...open, title: "Other" }], "x"), channel: "test" });
    expect(() => applyWorkflowCommand(null, { ...open, sequence: 1 }, { now: NOW, channel: { via: "approved", approval: other, batch: [{ ...open, title: "Other" }] } })).toThrow(/not part of what the user approved/);
  });
  it("Cyrillic titles get a descriptive Latin id", () => {
    expect(workItemIdFor("Список заказов", 1)).toBe("WI-SPISOK-ZAKAZOV-001");
    expect(workItemIdFor("Экспорт счетов в CSV", 2)).toBe("WI-EKSPORT-SCHETOV-V-CSV-002");
    expect(workItemIdFor("Order list", 1)).toBe("WI-ORDER-LIST-001");
  });
});
