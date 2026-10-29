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

import { buildRepositoryBrief, implementationOrder, repositoryProgress } from "./index.js";

describe("multi-repository coordination", () => {
  function threeRepos() {
    const c = (s: any, cmd: Record<string, unknown>) => applyWorkflowCommand(s, cmd, { now: NOW, channel: { via: "html-review" } }).state;
    let s = c(null, { action: "open", projectId: "p", title: "Orders everywhere", request: "web, ios and api", mode: "classic" });
    s = c(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "View orders", acceptanceCriteria: ["List shows orders"] });
    for (const [id, role] of [["api", "backend"], ["web", "web frontend"], ["ios", "mobile"]]) s = c(s, { action: "register-repository", repository: { id, name: id, role, localPath: `/tmp/${id}` } });
    s = c(s, { action: "set-service", service: { id: "svc-api", name: "API", kind: "api", repositoryId: "api", dependsOn: [], responsibilities: ["orders"], requirementIds: ["REQ-ORD-001"], status: "in_progress" } });
    s = c(s, { action: "set-service", service: { id: "svc-web", name: "Web", kind: "frontend", repositoryId: "web", dependsOn: ["svc-api"], responsibilities: ["ui"], requirementIds: ["REQ-ORD-001"], status: "in_progress" } });
    s = c(s, { action: "set-service", service: { id: "svc-ios", name: "iOS", kind: "frontend", repositoryId: "ios", dependsOn: ["svc-api"], responsibilities: ["ui"], requirementIds: ["REQ-ORD-001"], status: "in_progress" } });
    s = c(s, { action: "assign-repositories", repositoryIds: ["api", "web", "ios"], requirementIds: ["REQ-ORD-001"], serviceIds: [] });
    s = c(s, { action: "set-contract", contract: { id: "C-1", name: "Orders API", providerServiceId: "svc-api", consumerServiceIds: ["svc-web", "svc-ios"], status: "proposed" } });
    return s;
  }

  it("orders services across repositories by dependency", () => {
    const s = threeRepos();
    const { order, cycle } = implementationOrder(s);
    expect(order[0]).toBe("svc-api");
    expect(cycle).toEqual([]);
  });

  it("briefs each repository with what to implement, what it waits for and which contracts apply", () => {
    const s = threeRepos();
    const web = buildRepositoryBrief(s, "web");
    expect(web.services.map((x) => x.id)).toEqual(["svc-web"]);
    expect(web.waitsFor).toEqual([{ serviceId: "svc-api", repositoryId: "api", done: false }]);
    expect(web.contracts[0]).toMatchObject({ role: "consumes", status: "proposed" });
    expect(web.readyToStart).toBe(false);
    expect(web.blockers.join(" ")).toMatch(/waits for svc-api in api/);
    expect(buildRepositoryBrief(s, "api").contracts[0].role).toBe("provides");
  });

  it("never marks a repository nobody entered as done", () => {
    let s = threeRepos();
    s = applyWorkflowCommand(s, { action: "record-implementation", id: "IMPL-1", serviceId: "svc-api", requirementIds: ["REQ-ORD-001"], path: "src/orders.ts", summary: "API" }, { now: NOW }).state;
    const byRepo = Object.fromEntries(repositoryProgress(s).map((r) => [r.repositoryId, r]));
    expect(byRepo.api.entered).toBe(true);
    expect(byRepo.web.entered).toBe(false);
    expect(byRepo.ios.implemented).toBe(false);
    expect(byRepo.ios.verified).toBe(false);
  });

  it("a repository with stories but no service blocks the development phase", () => {
    const c = (s: any, cmd: Record<string, unknown>) => applyWorkflowCommand(s, cmd, { now: NOW }).state;
    let s = threeRepos();
    s = { ...s, services: s.services.filter((x) => x.id !== "svc-ios") };
    expect(phaseGatesFor(s)).toMatch(/repository ios has stories or requirements assigned but no service/);
    void c;
  });
});

import { phaseGates } from "./index.js";
function phaseGatesFor(s: any): string {
  return phaseGates(s, "development").missing.join("; ");
}
