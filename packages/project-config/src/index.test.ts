import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig, usesGherkinAcceptance } from "./index.js";

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

  it("reports invalid yaml/schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-project-"));
    writeFileSync(join(dir, ".project"), "requirementsFormat: not-a-real-format\n");
    const result = loadProjectConfig(dir);
    expect(result.status).toBe("invalid");
  });
});
