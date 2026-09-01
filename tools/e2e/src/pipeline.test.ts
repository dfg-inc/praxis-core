import { describe, expect, it } from "vitest";
import {
  ArchitectToDeveloperHandoffSchema,
  BaToArchitectHandoffSchema,
  DeveloperToQualityHandoffSchema,
  parseContract,
} from "@praxis/contracts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");

describe("pipeline handoffs BA → Arch → Dev → Quality", () => {
  it("builds and validates synthetic handoff chain", () => {
    const baToArch = parseContract(BaToArchitectHandoffSchema, {
      contract: "ba.architect.handoff",
      version: "0.1.0",
      workPackageId: "WP-20260825-001",
      workPackagePath: "canon/wp/WP-20260825-001.md",
      requirementIds: ["FR-1", "NFR-1"],
      visionConfirmed: true,
      readinessChecks: [
        { id: "ac-present", passed: true },
        { id: "vision", passed: true },
      ],
    });

    const archToDev = parseContract(ArchitectToDeveloperHandoffSchema, {
      contract: "architect.developer.handoff",
      version: "0.1.0",
      workPackageId: baToArch.workPackageId,
      designPackagePath: "design/WP-20260825-001/",
      contextSlicePath: "design/WP-20260825-001/context-slice.md",
      decisionIds: ["ADR-001"],
      features: [
        {
          id: "FEAT-1",
          title: "Intake API",
          estimateHours: 8,
          readyForDev: true,
        },
      ],
    });

    const devToQuality = parseContract(DeveloperToQualityHandoffSchema, {
      contract: "developer.quality.handoff",
      version: "0.1.0",
      workPackageId: baToArch.workPackageId,
      mergeRequestRef: "!42",
      intention: "Implement FEAT-1 per ADR-001",
      requirementIds: baToArch.requirementIds,
      decisionIds: archToDev.decisionIds,
      verification: {
        build: { status: "skipped", required: false },
        tests: { status: "passed", required: true },
        lint: { status: "skipped", required: false },
        packageCriteria: { status: "passed", required: true },
      },
    });

    expect(archToDev.workPackageId).toBe(baToArch.workPackageId);
    expect(devToQuality.requirementIds).toEqual(["FR-1", "NFR-1"]);
    expect(devToQuality.workPackageId).toBe(baToArch.workPackageId);
    expect(devToQuality.verification.tests.status).toBe("passed");
    expect(devToQuality.verification.build.status).toBe("skipped");
  });

  it("rejects broken BA handoff", () => {
    expect(() =>
      parseContract(BaToArchitectHandoffSchema, {
        contract: "ba.architect.handoff",
        version: "0.1.0",
        workPackageId: "WP-1",
        workPackagePath: "x",
        requirementIds: [],
        visionConfirmed: false,
        readinessChecks: [],
      }),
    ).toThrow();
  });

  it(
    "executes real BA → Architect → Developer → Quality fixture",
    { timeout: 120_000 },
    () => {
      const runner = join(here, "run-pipeline.mjs");
      const r = spawnSync(process.execPath, [runner, "--keep"], {
        encoding: "utf8",
        cwd: root,
      });
      if (r.status !== 0) {
        throw new Error(
          `pipeline failed:\n${r.stdout ?? ""}\n${r.stderr ?? ""}`,
        );
      }
      const summaryMatch = r.stdout.match(/PIPELINE OK\n\s*(\{[\s\S]*\})\s*$/);
      if (!summaryMatch) {
        throw new Error(`no PIPELINE OK summary in:\n${r.stdout}`);
      }
      const summary = JSON.parse(summaryMatch[1]!) as {
        ok: boolean;
        qualityVerdict: string;
        reviewsPersisted: number;
        greeter: string;
        baHandoffPath: string;
        archHandoffPath: string;
        qualityHandoffPath: string;
      };

      expect(summary.ok).toBe(true);
      expect(summary.qualityVerdict).toBe("pass");
      expect(summary.reviewsPersisted).toBeGreaterThanOrEqual(1);
      expect(summary.greeter).toContain("Hello, ${name}!");
      expect(summary.greeter).not.toContain("Hi, ${name}");

      const ba = parseContract(
        BaToArchitectHandoffSchema,
        JSON.parse(readFileSync(summary.baHandoffPath, "utf8")),
      );
      const arch = parseContract(
        ArchitectToDeveloperHandoffSchema,
        JSON.parse(readFileSync(summary.archHandoffPath, "utf8")),
      );
      const dq = parseContract(
        DeveloperToQualityHandoffSchema,
        JSON.parse(readFileSync(summary.qualityHandoffPath, "utf8")),
      );
      expect(ba.workPackageId).toBe("WP-20260825-001");
      expect(arch.workPackageId).toBe(ba.workPackageId);
      expect(dq.workPackageId).toBe(ba.workPackageId);
      expect(dq.decisionIds).toEqual(arch.decisionIds);
      expect(dq.verification.packageCriteria.status).toBe("passed");
      expect(dq.verification.tests.status).toBe("passed");
    },
  );

  it(
    "interactive-shaped machine handoff chain + Developer negatives",
    { timeout: 120_000 },
    () => {
      const runner = join(root, "tools/scripts/machine-handoff-chain.mjs");
      const r = spawnSync(process.execPath, [runner], {
        encoding: "utf8",
        cwd: root,
      });
      if (r.status !== 0) {
        throw new Error(
          `machine-handoff-chain failed:\n${r.stdout ?? ""}\n${r.stderr ?? ""}`,
        );
      }
      const chunks = (r.stdout ?? "").split(/\n(?=\{)/);
      let summary: {
        ok: boolean;
        accept: string;
        baHandoffPath: string;
        archHandoffPath: string;
        negatives: string[];
        baContract?: string;
        archContract?: string;
      } | null = null;
      for (let i = chunks.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(chunks[i]!);
          if (j.ok && j.accept) {
            summary = j;
            break;
          }
        } catch {
          /* continue */
        }
      }
      expect(summary).toBeTruthy();
      expect(summary!.accept).toBe("accepted");
      expect(summary!.baContract).toBe("ba.architect.handoff");
      expect(summary!.archContract).toBe("architect.developer.handoff");
      expect(summary!.archHandoffPath).toMatch(/architect-developer\.handoff\.json$/);
      expect(summary!.negatives).toEqual(
        expect.arrayContaining([
          "missing-handoff",
          "missing-change-spec",
          "readyForDev-false",
          "invalid-contract",
        ]),
      );
    },
  );

  it(
    "edit+create machine pipeline (create file + edit + npm test)",
    { timeout: 120_000 },
    () => {
      const runner = join(root, "tools/scripts/machine-edit-create-pipeline.mjs");
      const r = spawnSync(process.execPath, [runner], {
        encoding: "utf8",
        cwd: root,
      });
      if (r.status !== 0) {
        throw new Error(
          `edit-create pipeline failed:\n${r.stdout ?? ""}\n${r.stderr ?? ""}`,
        );
      }
      expect(r.stdout).toMatch(/"ok": true/);
      expect(r.stdout).toMatch(/edit\+create apply/);
    },
  );

  it(
    "Developer→Quality handoff artifacts (workPackageId, verification, acceptance)",
    { timeout: 120_000 },
    () => {
      const runner = join(root, "tools/scripts/machine-dq-quality-pipeline.mjs");
      const r = spawnSync(process.execPath, [runner], {
        encoding: "utf8",
        cwd: root,
      });
      if (r.status !== 0) {
        throw new Error(
          `dq-quality pipeline failed:\n${r.stdout ?? ""}\n${r.stderr ?? ""}`,
        );
      }
      expect(r.stdout).toMatch(/"ok": true/);
      expect(r.stdout).toMatch(/A workPackageId/);
      expect(r.stdout).toMatch(/C skipped/);
    },
  );
});
