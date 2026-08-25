import { describe, expect, it } from "vitest";
import {
  BaToArchitectHandoffSchema,
  ArchitectToDeveloperHandoffSchema,
  DeveloperToQualityHandoffSchema,
} from "./index.js";

describe("contracts", () => {
  it("accepts BA→Architect handoff", () => {
    const parsed = BaToArchitectHandoffSchema.parse({
      contract: "ba.architect.handoff",
      version: "1.0.0",
      workPackageId: "WP-20260825-001",
      workPackagePath: "canon/wp/WP-20260825-001",
      requirementIds: ["E1-FR1"],
      visionConfirmed: true,
      readinessChecks: [{ id: "ac-present", passed: true }],
    });
    expect(parsed.workPackageId).toBe("WP-20260825-001");
  });

  it("accepts Architect→Developer handoff", () => {
    const parsed = ArchitectToDeveloperHandoffSchema.parse({
      contract: "architect.developer.handoff",
      version: "1.0.0",
      workPackageId: "WP-20260825-001",
      designPackagePath: "architecture/design/WP-20260825-001",
      contextSlicePath: "architecture/slices/WP-20260825-001.md",
      decisionIds: ["ADR-001"],
      features: [{ id: "F1", title: "Login", readyForDev: true, estimateHours: 8 }],
    });
    expect(parsed.features).toHaveLength(1);
  });

  it("accepts Developer→Quality handoff", () => {
    const parsed = DeveloperToQualityHandoffSchema.parse({
      contract: "developer.quality.handoff",
      version: "1.0.0",
      mergeRequestRef: "!42",
      intention: "Implement login feature per ADR-001",
      requirementIds: ["E1-FR1"],
      decisionIds: ["ADR-001"],
      verification: { build: true, tests: true, lint: true, packageCriteria: true },
    });
    expect(parsed.verification.build).toBe(true);
  });
});
