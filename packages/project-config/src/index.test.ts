import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runApprovedForTest } from "@praxis/contracts";
import { loadProjectConfig, inferProjectConfig, writeProjectConfig, usesGherkinAcceptance } from "./index.js";

describe("loadProjectConfig", () => {
  it("returns defaults when .project is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-project-"));
    const result = loadProjectConfig(dir);
    expect(result.status).toBe("missing");
    if (result.status !== "missing") return;
    expect(result.unset).toContain("stack");
    expect(result.unset).toContain("knowledge.path");
    expect(usesGherkinAcceptance(result.config)).toBe(true);
  });

  it("loads gherkin format from .project", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-project-"));
    writeFileSync(
      join(dir, ".project"),
      [
        "stack: [typescript, node]",
        "requirementsFormat: история с критериями в сценарной форме",
        "requiredArtifacts: [vision, fr]",
        "environments: [dev, prod]",
        "knowledge:",
        "  path: ../knowledge",
        "  ref: main",
      ].join("\n"),
    );
    const result = loadProjectConfig(dir);
    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.config.stack).toEqual(["typescript", "node"]);
    expect(usesGherkinAcceptance(result.config)).toBe(true);
    expect(result.unset).toEqual([]);
  });

  it("loads optional knowledge.product and knowledge.service", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-project-"));
    writeFileSync(
      join(dir, ".project"),
      [
        "stack: [node]",
        "requirementsFormat: user-story-gherkin",
        "knowledge:",
        "  path: ./knowledge",
        "  product: demo",
        "  service: api",
      ].join("\n"),
    );
    const result = loadProjectConfig(dir);
    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.config.knowledge.product).toBe("demo");
    expect(result.config.knowledge.service).toBe("api");
  });

  it("reports invalid yaml/schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-project-"));
    writeFileSync(join(dir, ".project"), "requirementsFormat: not-a-real-format\n");
    const result = loadProjectConfig(dir);
    expect(result.status).toBe("invalid");
  });

  it("infers node/javascript and npm test without inventing missing scripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-project-"));
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2)}\n`,
    );
    const inferred = inferProjectConfig(dir);
    expect(inferred.existing.status).toBe("missing");
    expect(inferred.proposed.stack).toContain("node");
    expect(inferred.proposed.quality.test).toBe("npm test");
    expect(inferred.proposed.quality.build).toBeUndefined();
    expect(inferred.notes.some((n) => n.includes("build"))).toBe(true);
  });

  it("writes .project only via writeProjectConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-project-"));
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2)}\n`,
    );
    const inferred = inferProjectConfig(dir);
    expect(loadProjectConfig(dir).status).toBe("missing");
    expect(() => writeProjectConfig(dir, inferred.yaml)).toThrow(/direct mutation is not authorized/);
    runApprovedForTest("praxis_project_init_apply", () => writeProjectConfig(dir, inferred.yaml));
    const loaded = loadProjectConfig(dir);
    expect(loaded.status).toBe("loaded");
    if (loaded.status !== "loaded") return;
    expect(loaded.config.quality.test).toBe("npm test");
    expect(readFileSync(join(dir, ".project"), "utf8")).toContain("user-story-gherkin");
  });
});
