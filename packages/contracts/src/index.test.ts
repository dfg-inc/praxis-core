import { describe, expect, it } from "vitest";
import {
  BaToArchitectHandoffSchema,
  ArchitectToDeveloperHandoffSchema,
  DeveloperToQualityHandoffSchema,
  ChangeSpecSchema,
  ChangeSpecChangeSchema,
  normalizeChange,
  verificationCheckFromArbiterStep,
  computePackageCriteria,
  verificationIsReady,
  QualityMrContextSchema,
  QualityRollbackEventSchema,
} from "./index.js";

const structuredOk = {
  build: { status: "skipped", required: false },
  tests: { status: "passed", required: true },
  lint: { status: "skipped", required: false },
  packageCriteria: { status: "passed", required: true },
};

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

  it("accepts Developer→Quality handoff with workPackageId + structured verification", () => {
    const parsed = DeveloperToQualityHandoffSchema.parse({
      contract: "developer.quality.handoff",
      version: "1.0.0",
      workPackageId: "WP-20260825-001",
      mergeRequestRef: "!42",
      intention: "Implement login feature per ADR-001",
      requirementIds: ["E1-FR1"],
      decisionIds: ["ADR-001"],
      verification: structuredOk,
    });
    expect(parsed.workPackageId).toBe("WP-20260825-001");
    expect(parsed.verification.tests.status).toBe("passed");
    expect(parsed.verification.build.status).toBe("skipped");
    expect(verificationIsReady(parsed.verification)).toBe(true);
  });

  it("rejects Developer→Quality handoff without workPackageId", () => {
    expect(() =>
      DeveloperToQualityHandoffSchema.parse({
        contract: "developer.quality.handoff",
        version: "1.0.0",
        mergeRequestRef: "!42",
        intention: "x",
        requirementIds: [],
        decisionIds: [],
        verification: structuredOk,
      }),
    ).toThrow();
  });

  it("rejects legacy boolean-only verification", () => {
    expect(() =>
      DeveloperToQualityHandoffSchema.parse({
        contract: "developer.quality.handoff",
        version: "1.0.0",
        workPackageId: "WP-1",
        mergeRequestRef: "!42",
        intention: "x",
        requirementIds: [],
        decisionIds: [],
        verification: {
          build: true,
          tests: true,
          lint: true,
          packageCriteria: true,
        },
      }),
    ).toThrow();
  });

  it("maps arbiter skipped vs passed correctly", () => {
    expect(
      verificationCheckFromArbiterStep({ ok: true, skipped: true }, false),
    ).toEqual({ status: "skipped", required: false });
    expect(
      verificationCheckFromArbiterStep({ ok: true, skipped: false }, true),
    ).toEqual({ status: "passed", required: true });
    const pc = computePackageCriteria(
      { status: "skipped", required: false },
      { status: "passed", required: true },
      { status: "skipped", required: false },
    );
    expect(pc).toEqual({ status: "passed", required: true });
  });

  it("accepts create + edit change-spec entries", () => {
    const parsed = ChangeSpecSchema.parse({
      changes: [
        {
          file: "src/a.js",
          op: "edit",
          match: "x",
          replace: "y",
        },
        {
          file: "test/a.test.js",
          op: "create",
          content: "export {};\n",
        },
      ],
      features: [{ id: "F1", title: "t", readyForDev: true }],
      acceptanceChecks: [{ type: "npm-test" }],
    });
    expect(parsed.changes).toHaveLength(2);
    expect(normalizeChange(parsed.changes[1]!).op).toBe("create");
  });

  it("rejects edit without match/replace", () => {
    expect(() =>
      ChangeSpecChangeSchema.parse({ file: "a.js", op: "edit" }),
    ).toThrow();
  });

  it("accepts quality.mr.context and rollback/return contracts", () => {
    const ctx = QualityMrContextSchema.parse({
      contract: "quality.mr.context",
      version: "0.1.0",
      projectId: "p",
      workPackageId: "WP-1",
      mergeRequestRef: "local/WP-1",
      repositoryPath: "/tmp/repo",
      baseBranch: "main",
      headBranch: "feat",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      changedFiles: ["src/a.js"],
      requirementIds: ["FR-1"],
      decisionIds: ["ADR-1"],
    });
    expect(ctx.mergeRequestRef).toBe("local/WP-1");
    const rb = QualityRollbackEventSchema.parse({
      contract: "quality.rollback.event",
      version: "0.1.0",
      projectId: "p",
      mergeRequestRef: "local/WP-1",
      affectedRef: "abc",
      reason: "incident",
      trigger: "ops",
      status: "recorded",
      evidence: "log",
    });
    expect(rb.projectId).toBe("p");
  });
});
