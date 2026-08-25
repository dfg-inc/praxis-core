import { describe, expect, it } from "vitest";
import { getPluginVersion, readCatalog } from "../src/index.js";

describe("catalog", () => {
  it("lists role plugins with expected versions", () => {
    const cat = readCatalog();
    expect(cat.plugins.map((p) => p.name).sort()).toEqual([
      "praxis-architect",
      "praxis-ba",
      "praxis-developer",
    ]);
    expect(getPluginVersion("praxis-ba", cat)).toBe("0.4.0");
    expect(getPluginVersion("praxis-architect", cat)).toBe("0.1.0");
    expect(getPluginVersion("praxis-developer", cat)).toBe("0.1.0");
  });
});
