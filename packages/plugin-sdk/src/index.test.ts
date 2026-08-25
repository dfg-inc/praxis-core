import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootstrapSession,
  checkPluginVersion,
  formatSessionBootstrap,
  recordHumanGate,
} from "./index.js";

describe("human gate", () => {
  it("records approval", () => {
    const r = recordHumanGate({ decision: "approved", actor: "olga" });
    expect(r.decision).toBe("approved");
  });

  it("requires reason on reject", () => {
    expect(() =>
      recordHumanGate({ decision: "rejected", actor: "olga" }),
    ).toThrow(/reason/);
  });
});

describe("bootstrapSession", () => {
  it("continues when knowledge path missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-boot-"));
    const boot = bootstrapSession({
      repoRoot: dir,
      role: "ba",
      stage: "research",
      pluginName: "praxis-ba",
      pluginVersion: "0.4.0",
    });
    const text = formatSessionBootstrap(boot);
    expect(text).toMatch(/\.project missing/);
    expect(text).toMatch(/rules not applied/);
  });

  it("loads knowledge slice when path set", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-boot-"));
    const knowledge = join(dir, "knowledge");
    mkdirSync(join(knowledge, "company/rules"), { recursive: true });
    writeFileSync(
      join(knowledge, "company/rules/ba-research.md"),
      [
        "---",
        "id: ba-research",
        "roles: [ba]",
        "stages: [research]",
        "severity: advisory",
        "overridable: true",
        "---",
        "",
        "Read norms first.",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, ".project"),
      ["knowledge:", `  path: ${knowledge}`, "stack: [node]"].join("\n"),
    );
    const boot = bootstrapSession({
      repoRoot: dir,
      role: "ba",
      stage: "research",
      pluginName: "praxis-ba",
      pluginVersion: "0.4.0",
      latestVersion: "0.4.1",
    });
    expect(boot.knowledge.status).toBe("loaded");
    if (boot.knowledge.status === "loaded") {
      expect(boot.knowledge.count).toBe(1);
    }
    expect(formatSessionBootstrap(boot)).toMatch(/update available/);
  });
});

describe("checkPluginVersion", () => {
  it("warns but continues when outdated and canon compatible", () => {
    const r = checkPluginVersion({
      installed: "0.4.0",
      published: "0.4.1",
      installedCanonMajor: 3,
      requiredCanonMajor: 3,
    });
    expect(r.outdated).toBe(true);
    expect(r.continueAllowed).toBe(true);
    expect(r.updateCommand).toMatch(/claude plugin update/);
  });

  it("stops when canon major is unsupported", () => {
    const r = checkPluginVersion({
      installed: "0.3.0",
      published: "0.4.0",
      installedCanonMajor: 2,
      requiredCanonMajor: 3,
    });
    expect(r.incompatibleCanon).toBe(true);
    expect(r.continueAllowed).toBe(false);
  });
});
