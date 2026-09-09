import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootstrapSession,
  checkPluginVersion,
  formatSessionBootstrap,
  parseSessionBootstrapArgs,
  recordHumanGate,
} from "./index.js";

describe("parseSessionBootstrapArgs", () => {
  it("uses positional repo root over CWD", () => {
    const r = parseSessionBootstrapArgs(["/abs/product"], "/tmp/caller");
    expect(r.repoRoot).toBe("/abs/product");
  });

  it("falls back to CWD when argv is empty", () => {
    const r = parseSessionBootstrapArgs([], "/tmp/caller");
    expect(r.repoRoot).toBe("/tmp/caller");
  });

  it("uses --repo when no positional is given", () => {
    const r = parseSessionBootstrapArgs(["--repo", "/abs/via-flag"], "/tmp/caller");
    expect(r.repoRoot).toBe("/abs/via-flag");
  });

  it("lets positional win over --repo", () => {
    const r = parseSessionBootstrapArgs(
      ["/abs/positional", "--repo", "/abs/flag"],
      "/tmp/caller",
    );
    expect(r.repoRoot).toBe("/abs/positional");
  });
});

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
    expect(formatSessionBootstrap(boot)).toMatch(/ba-research/);
  });

  it("reports unavailable when knowledge.path does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-boot-miss-"));
    writeFileSync(
      join(dir, ".project"),
      ["knowledge:", "  path: /no/such/knowledge/root", "stack: [node]"].join(
        "\n",
      ),
    );
    const boot = bootstrapSession({
      repoRoot: dir,
      role: "ba",
      stage: "research",
      pluginName: "praxis-ba",
      pluginVersion: "0.4.0",
    });
    expect(boot.knowledge.status).toBe("unavailable");
    expect(formatSessionBootstrap(boot)).toMatch(/knowledge unavailable:/);
  });

  it("applies product override when knowledge.product is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-boot-ov-"));
    const knowledge = join(dir, "knowledge");
    mkdirSync(join(knowledge, "company/rules"), { recursive: true });
    mkdirSync(join(knowledge, "product/demo/rules"), { recursive: true });
    const rule = (id: string, title: string) =>
      [
        "---",
        `id: ${id}`,
        "roles: [ba]",
        "stages: [research]",
        "severity: advisory",
        "overridable: true",
        `title: ${title}`,
        "---",
        "",
        title,
      ].join("\n");
    writeFileSync(
      join(knowledge, "company/rules/override-demo.md"),
      rule("override-demo", "company"),
    );
    writeFileSync(
      join(knowledge, "product/demo/rules/override-demo.md"),
      rule("override-demo", "product"),
    );
    writeFileSync(
      join(dir, ".project"),
      [
        "knowledge:",
        `  path: ${knowledge}`,
        "  product: demo",
        "stack: [node]",
      ].join("\n"),
    );
    const boot = bootstrapSession({
      repoRoot: dir,
      role: "ba",
      stage: "research",
      pluginName: "praxis-ba",
      pluginVersion: "0.4.0",
    });
    expect(boot.knowledge.status).toBe("loaded");
    if (boot.knowledge.status === "loaded") {
      expect(boot.knowledge.ruleIds).toContain("override-demo");
      expect(boot.knowledge.count).toBe(1);
    }
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
