import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyVersionToData,
  applyVersionToFile,
  checkVersionConsistency,
  discoverVersionFiles,
  extractVersions,
  isValidSemVer,
  syncAllVersions,
} from "./release-lib.mjs";

describe("isValidSemVer", () => {
  it.each([
    "0.1.0",
    "0.1.0-alpha.1",
    "0.1.0-alpha.2",
    "0.1.0-beta.2",
    "0.1.0-rc.1",
    "1.2.3+build.7",
  ])("accepts %s", (v) => {
    expect(isValidSemVer(v)).toBe(true);
  });

  it.each(["", "1", "1.2", "v0.1.0", "0.1.0.1", "latest", "0.1.0-"])(
    "rejects %s",
    (v) => {
      expect(isValidSemVer(v)).toBe(false);
    },
  );
});

describe("applyVersionToData", () => {
  it("updates package.json version", () => {
    const data = { name: "x", version: "0.1.0" };
    expect(applyVersionToData("package.json", data, "0.2.0-alpha.1")).toBe(true);
    expect(data.version).toBe("0.2.0-alpha.1");
  });

  it("updates catalog plugin versions", () => {
    const data = {
      updated: "2020-01-01",
      plugins: [
        { name: "a", version: "0.1.0" },
        { name: "b", version: "0.4.0" },
      ],
    };
    expect(applyVersionToData("packages/catalog/catalog.json", data, "9.0.0")).toBe(
      true,
    );
    expect(data.plugins.every((p) => p.version === "9.0.0")).toBe(true);
    expect(data.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("updates marketplace.json plugin versions", () => {
    const data = {
      plugins: [{ name: "praxis-ba", version: "0.4.0" }],
    };
    applyVersionToData("plugins/ba/.claude-plugin/marketplace.json", data, "1.0.0");
    expect(data.plugins[0].version).toBe("1.0.0");
  });
});

describe("discover + sync on temp tree", () => {
  function seedTree() {
    const root = mkdtempSync(join(tmpdir(), "praxis-rel-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "praxis", version: "0.1.0-alpha.1" }, null, 2) +
        "\n",
    );
    mkdirSync(join(root, "packages/catalog"), { recursive: true });
    writeFileSync(
      join(root, "packages/catalog/package.json"),
      JSON.stringify({ name: "@praxis/catalog", version: "0.1.0" }, null, 2) +
        "\n",
    );
    writeFileSync(
      join(root, "packages/catalog/catalog.json"),
      JSON.stringify(
        {
          updated: "2026-01-01",
          plugins: [{ name: "praxis-ba", version: "0.4.0" }],
        },
        null,
        2,
      ) + "\n",
    );
    mkdirSync(join(root, "plugins/ba/.claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, "plugins/ba/package.json"),
      JSON.stringify({ name: "@praxis/ba", version: "0.4.0" }, null, 2) + "\n",
    );
    writeFileSync(
      join(root, "plugins/ba/.claude-plugin/plugin.json"),
      JSON.stringify({ name: "praxis-ba", version: "0.4.0" }, null, 2) + "\n",
    );
    writeFileSync(
      join(root, "plugins/ba/.claude-plugin/marketplace.json"),
      JSON.stringify(
        { plugins: [{ name: "praxis-ba", version: "0.4.0" }] },
        null,
        2,
      ) + "\n",
    );
    // fixtures must NOT be discovered
    mkdirSync(join(root, "samples/mini-counter"), { recursive: true });
    writeFileSync(
      join(root, "samples/mini-counter/package.json"),
      JSON.stringify({ name: "mini", version: "9.9.9" }, null, 2) + "\n",
    );
    return root;
  }

  it("discovers version files and skips samples", () => {
    const root = seedTree();
    const files = discoverVersionFiles(root);
    expect(files).toContain("package.json");
    expect(files).toContain("packages/catalog/catalog.json");
    expect(files).toContain("plugins/ba/.claude-plugin/plugin.json");
    expect(files.some((f) => f.includes("samples"))).toBe(false);
  });

  it("syncAllVersions dry-run does not write", () => {
    const root = seedTree();
    const before = readFileSync(join(root, "plugins/ba/package.json"), "utf8");
    const { changed } = syncAllVersions(root, "0.1.0-alpha.2", { dryRun: true });
    expect(changed.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, "plugins/ba/package.json"), "utf8")).toBe(
      before,
    );
  });

  it("syncAllVersions writes and version:check passes", () => {
    const root = seedTree();
    syncAllVersions(root, "0.1.0-alpha.2", { dryRun: false });
    applyVersionToFile(root, "package.json", "0.1.0-alpha.2");
    const report = checkVersionConsistency(root, "0.1.0-alpha.2");
    expect(report.ok).toBe(true);
    expect(
      extractVersions(
        "packages/catalog/catalog.json",
        JSON.parse(
          readFileSync(join(root, "packages/catalog/catalog.json"), "utf8"),
        ),
      ).versions.every((v) => v === "0.1.0-alpha.2"),
    ).toBe(true);
  });

  it("checkVersionConsistency reports mismatches", () => {
    const root = seedTree();
    const report = checkVersionConsistency(root, "0.1.0-alpha.1");
    expect(report.ok).toBe(false);
    expect(report.mismatches.length).toBeGreaterThan(0);
  });
});
