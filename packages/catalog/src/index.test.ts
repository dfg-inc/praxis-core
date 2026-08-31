import { describe, expect, it } from "vitest";
import { getPluginVersion, readCatalog } from "../src/index.js";

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

describe("catalog", () => {
  it("lists role plugins with SemVer versions", () => {
    const cat = readCatalog();
    expect(cat.plugins.map((p) => p.name).sort()).toEqual([
      "praxis-architect",
      "praxis-ba",
      "praxis-developer",
    ]);

    for (const plugin of cat.plugins) {
      expect(plugin.version).toMatch(SEMVER_RE);
      expect(getPluginVersion(plugin.name, cat)).toBe(plugin.version);
    }
  });
});
