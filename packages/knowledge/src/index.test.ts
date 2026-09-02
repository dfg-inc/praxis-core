import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadApplicableSlice, parsePrecedent, prepareFindingProposal, rejectFindingProposal, loadFindingStore, saveFindingStore } from "./index.js";

function writeRule(dir: string, id: string, roles: string[], stages: string[]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    [
      "---",
      `id: ${id}`,
      `roles: [${roles.join(", ")}]`,
      `stages: [${stages.join(", ")}]`,
      "severity: mandatory",
      "overridable: true",
      "---",
      "",
      "Body.",
    ].join("\n"),
  );
}

describe("knowledge slice", () => {
  it("returns product override over company", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-knowledge-"));
    writeRule(join(root, "company/rules"), "task-schema", ["ba", "architect"], ["plan"]);
    writeRule(join(root, "product/gds/rules"), "task-schema", ["ba"], ["plan"]);
    const slice = loadApplicableSlice({
      knowledgeRoot: root,
      role: "ba",
      stage: "plan",
      product: "gds",
    });
    expect(slice.rules).toHaveLength(1);
    expect(slice.rules[0].level).toBe("product");
  });

  it("returns service override over product", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-knowledge-"));
    writeRule(join(root, "company/rules"), "task-schema", ["ba"], ["plan"]);
    writeRule(join(root, "product/gds/rules"), "task-schema", ["ba"], ["plan"]);
    writeRule(join(root, "service/api/rules"), "task-schema", ["ba"], ["plan"]);
    const slice = loadApplicableSlice({
      knowledgeRoot: root,
      role: "ba",
      stage: "plan",
      product: "gds",
      service: "api",
    });
    expect(slice.rules).toHaveLength(1);
    expect(slice.rules[0].level).toBe("service");
  });

  it("filters by role and stage", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-knowledge-"));
    writeRule(join(root, "company/rules"), "ba-only", ["ba"], ["research"]);
    writeRule(join(root, "company/rules"), "arch-plan", ["architect"], ["plan"]);
    const slice = loadApplicableSlice({
      knowledgeRoot: root,
      role: "architect",
      stage: "plan",
    });
    expect(slice.rules.map((r) => r.frontmatter.id)).toEqual(["arch-plan"]);
  });

  it("empty slice message", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-knowledge-"));
    mkdirSync(join(root, "company/rules"), { recursive: true });
    const slice = loadApplicableSlice({
      knowledgeRoot: root,
      role: "developer",
      stage: "implement",
    });
    expect(slice.emptyMessage).toMatch(/none/);
  });
});

describe("precedent template", () => {
  it("parses four required sections", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-prec-"));
    const path = join(root, "p.md");
    writeFileSync(
      path,
      [
        "## Circumstances",
        "Two services need async exchange.",
        "## Chosen",
        "Message queue.",
        "## Rejected",
        "Sync HTTP.",
        "## Why",
        "Backpressure.",
      ].join("\n"),
    );
    const p = parsePrecedent(path);
    expect("error" in p).toBe(false);
  });
});

describe("finding lift", () => {
  it("proposes a rule from architecture decisions", () => {
    const store = { proposals: [], rejections: [] };
    const first = prepareFindingProposal(store, {
      kind: "architecture-decision",
      proposedRuleId: "async-between-services",
      title: "Prefer queue for cross-service writes",
      body: "Use a queue when two services exchange write-side events.",
      sourceRefs: ["product-a/ADR-12", "product-b/ADR-3"],
    });
    expect(first.status).toBe("proposed");
    if (first.status !== "proposed") return;
    rejectFindingProposal(store, first.proposal, "too narrow");
    const again = prepareFindingProposal(store, {
      kind: "architecture-decision",
      proposedRuleId: "async-between-services",
      title: "Prefer queue for cross-service writes",
      body: "Use a queue when two services exchange write-side events.",
      sourceRefs: ["product-a/ADR-12", "product-b/ADR-3"],
    });
    expect(again.status).toBe("suppressed");
  });

  it("persists finding store to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "finding-store-"));
    const path = join(dir, "findings.json");
    const store = loadFindingStore(path);
    const first = prepareFindingProposal(store, {
      kind: "repeated-choice",
      proposedRuleId: "prefer-hello",
      title: "Prefer Hello greeting",
      body: "formatGreeting must use Hello",
      sourceRefs: ["WP-1", "ADR-1"],
    });
    expect(first.status).toBe("proposed");
    saveFindingStore(path, store);
    const reloaded = loadFindingStore(path);
    expect(reloaded.proposals).toHaveLength(1);
    expect(reloaded.proposals[0]?.proposedRuleId).toBe("prefer-hello");
  });
});
