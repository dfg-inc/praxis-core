// @vitest-environment node
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import { applyWorkflowCommand, migrateWorkflowState, openLocalWorkflow, phaseGates, renderReview, submissionToCommands, WorkflowStateSchema, type WorkflowState } from "./index.js";

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
    let s = run(null, { action: "open", projectId: "p", title: "Orders", request: "r", mode: "classic" });
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
    const plan = submissionToCommands(guided, { contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: guided.workItem.id, baseFingerprint: "x", modeChange: { to: "classic", reason: "no" } });
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
    expect(submission.contracts).toEqual({ agree: ["C-1"] });
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
