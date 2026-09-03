import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadApplicableSlice,
  parsePrecedent,
  parseScopedPrecedentFile,
  prepareFindingProposal,
  prepareSuccessfulOverrideFinding,
  rejectFindingProposal,
  acceptFindingProposal,
  loadFindingStore,
  saveFindingStore,
  ruleRequiresObsoleteToolReview,
} from "./index.js";

function writeRule(
  dir: string,
  id: string,
  roles: string[],
  stages: string[],
  extraFm: string[] = [],
) {
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
      ...extraFm,
      "---",
      "",
      "Body.",
    ].join("\n"),
  );
}

function writePrecedent(
  dir: string,
  id: string,
  roles: string[],
  stages: string[],
  opts: { omitSection?: string; badFrontmatter?: boolean } = {},
) {
  mkdirSync(dir, { recursive: true });
  const sections = [
    ["Circumstances", "Situation A."],
    ["Chosen", "Option X."],
    ["Rejected", "Option Y."],
    ["Why", "Reason Z."],
  ].filter(([name]) => name !== opts.omitSection);
  const fm = opts.badFrontmatter
    ? ["---", "title: missing id", "---", ""]
    : [
        "---",
        `id: ${id}`,
        `roles: [${roles.join(", ")}]`,
        `stages: [${stages.join(", ")}]`,
        "---",
        "",
      ];
  writeFileSync(
    join(dir, `${id}.md`),
    [
      ...fm,
      ...sections.flatMap(([name, body]) => [`## ${name}`, body, ""]),
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
    expect(slice.precedents).toEqual([]);
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

  it("one rule applies to multiple roles without duplicate files", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-knowledge-"));
    writeRule(join(root, "company/rules"), "shared", ["ba", "architect"], ["research", "plan"]);
    const ba = loadApplicableSlice({
      knowledgeRoot: root,
      role: "ba",
      stage: "research",
    });
    const arch = loadApplicableSlice({
      knowledgeRoot: root,
      role: "architect",
      stage: "plan",
    });
    expect(ba.rules).toHaveLength(1);
    expect(arch.rules).toHaveLength(1);
    expect(ba.rules[0].path).toBe(arch.rules[0].path);
  });

  it("reports malformed rule frontmatter fields", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-knowledge-"));
    mkdirSync(join(root, "company/rules"), { recursive: true });
    writeFileSync(
      join(root, "company/rules/bad.md"),
      ["---", "title: no-id", "roles: [ba]", "---", "", "x"].join("\n"),
    );
    const slice = loadApplicableSlice({
      knowledgeRoot: root,
      role: "ba",
      stage: "research",
    });
    expect(slice.errors.some((e) => /missing\/invalid frontmatter:.*id/.test(e))).toBe(
      true,
    );
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

  it("returns scoped precedents for matching product context", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-knowledge-"));
    writePrecedent(
      join(root, "company/precedents"),
      "PREC-company",
      ["architect"],
      ["plan"],
    );
    writePrecedent(
      join(root, "product/demo/precedents"),
      "PREC-demo",
      ["architect"],
      ["plan"],
    );
    writePrecedent(
      join(root, "product/other/precedents"),
      "PREC-other",
      ["architect"],
      ["plan"],
    );
    const slice = loadApplicableSlice({
      knowledgeRoot: root,
      role: "architect",
      stage: "plan",
      product: "demo",
    });
    const ids = slice.precedents.map((p) => p.frontmatter.id).sort();
    expect(ids).toEqual(["PREC-company", "PREC-demo"]);
    expect(ids).not.toContain("PREC-other");
    const demo = slice.precedents.find((p) => p.frontmatter.id === "PREC-demo");
    expect(demo?.circumstances).toMatch(/Situation A/);
    expect(demo?.chosen).toMatch(/Option X/);
    expect(demo?.rejected).toMatch(/Option Y/);
    expect(demo?.why).toMatch(/Reason Z/);
  });

  it("surfaces malformed precedents as errors", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-knowledge-"));
    writePrecedent(join(root, "company/precedents"), "PREC-bad", ["architect"], ["plan"], {
      omitSection: "Why",
    });
    writePrecedent(join(root, "company/precedents"), "PREC-fm", ["architect"], ["plan"], {
      badFrontmatter: true,
    });
    // overwrite PREC-fm path — badFrontmatter writes title-only; ensure file exists
    const slice = loadApplicableSlice({
      knowledgeRoot: root,
      role: "architect",
      stage: "plan",
    });
    expect(slice.precedents.find((p) => p.frontmatter.id === "PREC-bad")).toBeUndefined();
    expect(slice.errors.some((e) => /missing required sections/.test(e))).toBe(true);
    expect(slice.errors.some((e) => /missing\/invalid frontmatter/.test(e))).toBe(true);
  });

  it("exposes obsolete tool binding review on migrated rules", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-knowledge-"));
    writeRule(join(root, "company/rules"), "tracker-workflow", ["ba"], ["research"], [
      "sourceDoc: handbook",
      'sourceVersion: "1.0.0"',
      "obsoleteToolBinding:",
      "  toolId: legacy-jira-server",
      "  reason: retired tracker",
      "  proceduralContentApplicable: true",
      "  reviewRequired: true",
    ]);
    const slice = loadApplicableSlice({
      knowledgeRoot: root,
      role: "ba",
      stage: "research",
    });
    expect(slice.rules).toHaveLength(1);
    expect(slice.rules[0].body).toMatch(/Body/);
    expect(ruleRequiresObsoleteToolReview(slice.rules[0])).toBe(true);
    expect(slice.rules[0].frontmatter.obsoleteToolBinding?.toolId).toBe(
      "legacy-jira-server",
    );
    expect(slice.rules[0].frontmatter.sourceDoc).toBe("handbook");
    expect(slice.rules[0].frontmatter.sourceVersion).toBe("1.0.0");
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

  it("parseScopedPrecedentFile requires frontmatter and sections", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-scoped-prec-"));
    const path = join(root, "p.md");
    writeFileSync(
      path,
      [
        "---",
        "id: PREC-1",
        "roles: [architect]",
        "stages: [plan]",
        "---",
        "",
        "## Circumstances",
        "A",
        "## Chosen",
        "B",
        "## Rejected",
        "C",
        "## Why",
        "D",
      ].join("\n"),
    );
    const p = parseScopedPrecedentFile(path, "company");
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.frontmatter.id).toBe("PREC-1");
    expect(p.why).toBe("D");
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
    expect(first.proposal.sourceRefs).toEqual(["product-a/ADR-12", "product-b/ADR-3"]);
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

  it("successful-override finding identifies parent rule and override source", () => {
    const store = { proposals: [], rejections: [] };
    const result = prepareSuccessfulOverrideFinding(store, {
      originalRuleId: "prefer-sync-dc",
      overrideLevel: "product",
      overrideSource: "demo",
      sourceRefs: ["demo/ADR-9"],
    });
    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") return;
    expect(result.proposal.kind).toBe("successful-override");
    expect(result.proposal.proposedRuleId).toBe("prefer-sync-dc");
    expect(result.proposal.body).toMatch(/reconsider|review/i);
    expect(result.proposal.sourceRefs).toEqual(
      expect.arrayContaining([
        "demo/ADR-9",
        "original-rule:prefer-sync-dc",
        "override:product/demo",
      ]),
    );
    acceptFindingProposal(store, result.proposal);
    expect(result.proposal.status).toBe("accepted");
    // store only — no corpus write
    expect(store.proposals).toHaveLength(1);
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
