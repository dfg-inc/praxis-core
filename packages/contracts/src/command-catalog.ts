import { z } from "zod";
import { isUserDecision } from "./planning.js";
import { WorkflowCommandSchema } from "./workflow.js";

/**
 * What an agent needs to write a workflow command without guessing: every action with its required and optional fields,
 * and a minimal working example for the ones whose shape is not obvious. Built from the same schemas the reducer parses,
 * so it cannot drift.
 */
export type CommandInfo = { action: string; required: string[]; optional: string[]; userOnly: boolean; example?: Record<string, unknown> };

const optionalish = (type: z.ZodTypeAny): boolean => type instanceof z.ZodOptional || type instanceof z.ZodDefault || (type instanceof z.ZodNullable && optionalish(type.unwrap()));

const EXAMPLES: Record<string, Record<string, unknown>> = {
  open: { action: "open", projectId: "orders", title: "Order list", request: "Managers need to see and search orders", mode: "guided" },
  "add-requirement": { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view and search orders", acceptanceCriteria: ["The list shows all orders", "A manager can search by number"] },
  "set-prototype": { action: "set-prototype", summary: "first version", prototype: { kind: "ui", title: "Orders", startScreen: "list", roles: ["manager", "viewer"], styles: { colors: { primary: "#0b6bcb" }, fonts: {}, sources: [{ file: "src/theme.css" }] }, mock: [{ id: "orders", name: "Orders", fields: [{ key: "number", label: "Number", type: "string" }], rows: [{ number: "A-1" }] }], screens: [{ id: "list", title: "Orders", states: ["default", "empty", "error"], elements: [{ id: "tbl", kind: "table", collection: "orders", columns: ["number"], intent: "view", requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-01"] }] }] } },
  "update-prototype": { action: "update-prototype", summary: "added a column", operations: [{ op: "update-element", screenId: "list", id: "tbl", patch: { columns: ["number", "status"] } }] },
  "set-story-plan": { action: "set-story-plan", entries: [{ id: "US-ORD-001", title: "See and search orders", implementation: "list page with search", userGets: "all orders, found by number", requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-01"], screenRefs: ["list"], capabilities: ["view", "search", "states"] }] },
  "add-story": { action: "add-story", id: "US-ORD-001", requirementIds: ["REQ-ORD-001"], actor: "manager", narrative: "As a manager, I want to see orders, so that I can work.", objective: "see orders", userValue: "no manual lookup", happyPath: ["open the list"], acceptanceCriteria: [{ id: "US-ORD-001-AC-01", given: "orders exist", when: "the manager opens the list", then: "all orders are shown" }], expectedResults: ["the list is shown"], confirmedBehavior: false },
  "update-story": { action: "update-story", id: "US-ORD-001", patch: { objective: "find orders quickly" }, criteria: [{ op: "add", given: "no order matches", when: "searching", then: "an empty state is shown" }], reason: "the user asked for the empty state" },
  "register-repository": { action: "register-repository", repository: { id: "web", name: "Orders web", role: "web frontend", localPath: "/path/to/checkout" } },
  "assign-repositories": { action: "assign-repositories", repositoryIds: ["web"], storyIds: ["US-ORD-001"], requirementIds: ["REQ-ORD-001"], serviceIds: ["svc-web"] },
  "set-service": { action: "set-service", service: { id: "svc-web", name: "Web", kind: "frontend", repositoryId: "web", responsibilities: ["orders ui"], requirementIds: ["REQ-ORD-001"], dependsOn: ["svc-api"], status: "in_progress" } },
  "set-contract": { action: "set-contract", contract: { id: "C-1", name: "Orders API", providerServiceId: "svc-api", consumerServiceIds: ["svc-web"], schemaRef: "openapi.yaml", status: "proposed" } },
  "record-impact": { action: "record-impact", impact: { baseline: { summary: "orders list exists", behaviors: [{ id: "B1", statement: "The list shows orders", evidence: [{ repositoryId: "web", path: "src/pages/Orders.tsx" }] }] }, affected: [{ repositoryId: "web", path: "src/pages/Orders.tsx", area: "orders page", change: "add export button" }], regressionChecks: [{ id: "R1", statement: "The list still shows all orders" }] } },
  "record-implementation": { action: "record-implementation", id: "IMPL-1", serviceId: "svc-web", requirementIds: ["REQ-ORD-001"], path: "src/pages/Orders.tsx", summary: "orders list with search" },
  "review-requirements": { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", statement: "Managers can view, search and filter orders", addAcceptance: [{ statement: "Filtering by status works" }] }] },
  "set-requirement-scope": { action: "set-requirement-scope", requirementIds: ["REQ-ORD-002"], scope: "deferred", note: "next release" },
  "advance-phase": { action: "advance-phase", to: "prototype" },
  "return-to-phase": { action: "return-to-phase", to: "requirements_review", reason: "the user changed the search requirement" },
  "log-session": { action: "log-session", summary: "Requirements accepted", nextAction: "build the prototype", role: "ba" },
  "waive-coverage": { action: "waive-coverage", kind: "prototype", reason: "pure refactor, nothing to show" },
};

export function commandCatalog(): CommandInfo[] {
  return (WorkflowCommandSchema.options as unknown as Array<z.ZodObject<z.ZodRawShape>>).map((schema) => {
    const action = (schema.shape.action as z.ZodLiteral<string>).value;
    const required: string[] = [];
    const optional: string[] = [];
    for (const [key, type] of Object.entries(schema.shape)) {
      if (key === "action") continue;
      (optionalish(type) ? optional : required).push(key);
    }
    let userOnly = false;
    try {
      userOnly = isUserDecision({ action, decisions: [{ acceptance: [{ status: "x" }] }], operations: [{ op: "review" }] } as never);
    } catch {
      userOnly = false;
    }
    return { action, required, optional, userOnly, ...(EXAMPLES[action] ? { example: EXAMPLES[action] } : {}) };
  });
}

/** Human-readable failure for an invalid command: which fields, not a raw issue array. */
export function explainCommandError(error: unknown): string | undefined {
  if (!(error instanceof z.ZodError)) return undefined;
  const lines = error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "(command)"}: ${issue.message}`);
  return `the command is invalid: ${lines.join("; ")}. praxis_workflow_commands lists every action with its fields and an example.`;
}
