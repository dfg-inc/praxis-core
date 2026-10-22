import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INTERNAL_WORKSPACE_RANGE,
  applyInternalWorkspaceDeps,
  applyVersionToData,
  applyVersionToFile,
  checkEcosystemRelease,
  checkInternalWorkspaceDeps,
  checkVersionConsistency,
  discoverVersionFiles,
  extractVersions,
  isValidSemVer,
  listInternalDependencyRefs,
  syncAllVersions,
  syncInternalWorkspaceDeps,
  syncVendorPins,
} from "./release-lib.mjs";

// These tests build fixture repositories at fixed versions. In a tag pipeline CI_COMMIT_TAG names the real release, which
// would be compared with the fixtures, so the tag environment is cleared for every test and restored afterwards.
const TAG_ENV = ["CI_COMMIT_TAG", "GITHUB_REF_TYPE", "GITHUB_REF_NAME"];
let savedTagEnv = {};
beforeEach(() => {
  savedTagEnv = Object.fromEntries(TAG_ENV.map((key) => [key, process.env[key]]));
  for (const key of TAG_ENV) delete process.env[key];
});
afterEach(() => {
  for (const key of TAG_ENV) {
    if (savedTagEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedTagEnv[key];
  }
});

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

  it("leaves other products' catalog versions unchanged", () => {
    const data = {
      updated: "2020-01-01",
      plugins: [
        { name: "a", version: "0.1.0" },
        { name: "b", version: "0.4.0" },
      ],
    };
    expect(applyVersionToData("packages/catalog/catalog.json", data, "9.0.0")).toBe(
      false,
    );
    expect(data.plugins.map((p) => p.version)).toEqual(["0.1.0", "0.4.0"]);
    expect(data.updated).toBe("2020-01-01");
  });

  it("updates marketplace.json plugin versions", () => {
    const data = {
      plugins: [{ name: "praxis-ba", version: "0.4.0" }],
    };
    applyVersionToData("plugins/ba/.claude-plugin/marketplace.json", data, "1.0.0");
    expect(data.plugins[0].version).toBe("1.0.0");
  });
});

describe("internal workspace dependencies", () => {
  function seedDepsTree() {
    const root = mkdtempSync(join(tmpdir(), "praxis-deps-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "praxis", version: "0.1.0-alpha.2" }, null, 2) +
        "\n",
    );
    mkdirSync(join(root, "packages/knowledge"), { recursive: true });
    mkdirSync(join(root, "packages/plugin-sdk"), { recursive: true });
    writeFileSync(
      join(root, "packages/knowledge/package.json"),
      JSON.stringify(
        { name: "@praxis/knowledge", version: "0.1.0-alpha.2" },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(root, "packages/plugin-sdk/package.json"),
      JSON.stringify(
        {
          name: "@praxis/plugin-sdk",
          version: "0.1.0-alpha.2",
          dependencies: { "@praxis/knowledge": "0.1.0" },
        },
        null,
        2,
      ) + "\n",
    );
    return root;
  }

  it("lists pinned internal deps as mismatches", () => {
    const root = seedDepsTree();
    const refs = listInternalDependencyRefs(root);
    expect(refs).toEqual([
      expect.objectContaining({
        path: "packages/plugin-sdk/package.json",
        name: "@praxis/knowledge",
        range: "0.1.0",
      }),
    ]);
    const check = checkInternalWorkspaceDeps(root);
    expect(check.ok).toBe(false);
    expect(check.mismatches[0].expected).toBe(INTERNAL_WORKSPACE_RANGE);
  });

  it("rewrites exact pins to *", () => {
    const root = seedDepsTree();
    const { changed } = syncInternalWorkspaceDeps(root, { dryRun: false });
    expect(changed).toContain("packages/plugin-sdk/package.json");
    const pkg = JSON.parse(
      readFileSync(join(root, "packages/plugin-sdk/package.json"), "utf8"),
    );
    expect(pkg.dependencies["@praxis/knowledge"]).toBe("*");
    expect(checkInternalWorkspaceDeps(root).ok).toBe(true);
  });

  it("applyInternalWorkspaceDeps is a no-op when already correct", () => {
    const data = {
      dependencies: { "@praxis/knowledge": "*", lodash: "4.0.0" },
    };
    expect(
      applyInternalWorkspaceDeps(data, new Set(["@praxis/knowledge"])),
    ).toBe(false);
  });

  it("syncAllVersions also rewrites internal deps", () => {
    const root = seedDepsTree();
    const { depChanged } = syncAllVersions(root, "0.1.0-alpha.3", {
      dryRun: false,
    });
    expect(depChanged).toContain("packages/plugin-sdk/package.json");
    applyVersionToFile(root, "package.json", "0.1.0-alpha.3");
    const after = checkVersionConsistency(root, "0.1.0-alpha.3");
    expect(after.ok).toBe(true);
    expect(after.internalDeps.ok).toBe(true);
  });

  it("checkVersionConsistency reports exact-pin dep drift", () => {
    const root = seedDepsTree();
    const report = checkVersionConsistency(root, "0.1.0-alpha.2");
    expect(report.ok).toBe(false);
    expect(
      report.mismatches.some((m) => m.kind === "internal-dependency"),
    ).toBe(true);
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
      ).versions,
    ).toEqual(["0.4.0"]);
  });

  function writeIndependentRepo(root, { product, vendor, pin }) {
    mkdirSync(join(root, "vendor"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify(
        {
          name: "praxis-runtime",
          version: product,
          dependencies: {
            "@praxis/contracts": `file:vendor/praxis-contracts-${pin}.tgz`,
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(root, "ecosystem.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          policy: "independent",
          version: product,
          repositories: [
            "praxis-core",
            "praxis-runtime",
            "praxis-ba",
            "praxis-architect",
            "praxis-developer",
            "praxis-quality",
          ],
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(root, "vendor", `praxis-contracts-${pin}.tgz`), "vendor");
    writeFileSync(
      join(root, "vendor", "manifest.json"),
      JSON.stringify({ version: vendor, packages: ["@praxis/contracts"] }) + "\n",
    );
  }

  it("rejects a vendor pin that disagrees with the vendor manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-vendor-"));
    writeIndependentRepo(root, {
      product: "0.1.0-alpha.47",
      vendor: "0.1.0-alpha.47",
      pin: "0.1.0-alpha.45",
    });
    const before = checkEcosystemRelease(root);
    expect(before.ok).toBe(false);
    expect(before.mismatches.some((m) => m.kind === "vendor-pin" || m.kind === "stale-vendor-tarball")).toBe(
      true,
    );
  });

  it("allows this product to differ from a consistent Core vendor pin", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-vendor-"));
    writeIndependentRepo(root, {
      product: "0.1.0-alpha.47",
      vendor: "0.1.0-alpha.45",
      pin: "0.1.0-alpha.45",
    });
    expect(checkEcosystemRelease(root).ok).toBe(true);
    syncAllVersions(root, "0.1.0-alpha.48", { dryRun: false });
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.version).toBe("0.1.0-alpha.48");
    expect(pkg.dependencies["@praxis/contracts"]).toBe(
      "file:vendor/praxis-contracts-0.1.0-alpha.45.tgz",
    );
    const pins = syncVendorPins(root, "0.1.0-alpha.46", { dryRun: false });
    expect(pins.changed).toContain("package.json");
    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(after.version).toBe("0.1.0-alpha.48");
    expect(after.dependencies["@praxis/contracts"]).toBe(
      "file:vendor/praxis-contracts-0.1.0-alpha.46.tgz",
    );
    expect(JSON.parse(readFileSync(join(root, "vendor", "manifest.json"), "utf8")).version).toBe(
      "0.1.0-alpha.46",
    );
  });

  it("does not require a sibling checkout to use the same version", () => {
    const parent = mkdtempSync(join(tmpdir(), "praxis-siblings-"));
    const root = join(parent, "praxis-runtime");
    mkdirSync(root, { recursive: true });
    writeIndependentRepo(root, {
      product: "0.1.0-alpha.47",
      vendor: "0.1.0-alpha.45",
      pin: "0.1.0-alpha.45",
    });
    const sibling = join(parent, "praxis-ba");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(
      join(sibling, "ecosystem.json"),
      JSON.stringify({ schemaVersion: 1, policy: "independent", version: "0.1.0-alpha.40" }) + "\n",
    );
    expect(checkEcosystemRelease(root).ok).toBe(true);
  });

  it("rejects a lockstep policy and does not retarget vendor pins", () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-vendor-"));
    writeIndependentRepo(root, {
      product: "0.1.0-alpha.47",
      vendor: "0.1.0-alpha.45",
      pin: "0.1.0-alpha.45",
    });
    const ecosystem = JSON.parse(readFileSync(join(root, "ecosystem.json"), "utf8"));
    ecosystem.policy = "lockstep";
    writeFileSync(join(root, "ecosystem.json"), JSON.stringify(ecosystem, null, 2) + "\n");
    const before = checkEcosystemRelease(root);
    expect(before.ok).toBe(false);
    expect(before.mismatches.some((m) => m.kind === "ecosystem" && m.found === "lockstep")).toBe(true);
    syncAllVersions(root, "0.1.0-alpha.47", { dryRun: false });
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.dependencies["@praxis/contracts"]).toBe(
      "file:vendor/praxis-contracts-0.1.0-alpha.45.tgz",
    );
  });

  it("checkVersionConsistency reports mismatches", () => {
    const root = seedTree();
    const report = checkVersionConsistency(root, "0.1.0-alpha.1");
    expect(report.ok).toBe(false);
    expect(report.mismatches.length).toBeGreaterThan(0);
  });
});
