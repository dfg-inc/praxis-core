import { describe, expect, it } from "vitest";
import {
  REQUIRED_PATHS,
  collectPackagePathRefs,
  PLUGIN_IDS,
} from "./package-plugins.mjs";

describe("package-plugins contracts", () => {
  it("defines required paths for every release plugin", () => {
    for (const id of PLUGIN_IDS) {
      expect(REQUIRED_PATHS[id]?.length).toBeGreaterThan(3);
    }
  });

  it("jira contract requires compiled dist entrypoints", () => {
    expect(REQUIRED_PATHS.jira).toContain("dist/index.js");
    expect(REQUIRED_PATHS.jira).toContain("dist/index.d.ts");
  });

  it("ba contract requires bundled CLI", () => {
    expect(REQUIRED_PATHS.ba).toContain("bin/praxis-ba.cjs");
  });

  it("collectPackagePathRefs reads main/bin/exports/scripts", () => {
    const refs = collectPackagePathRefs({
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      bin: { "praxis-ba": "./bin/praxis-ba.cjs" },
      exports: { ".": { default: "./dist/index.js" } },
      scripts: { "session-bootstrap": "node ./tools/session-bootstrap.mjs" },
    });
    expect(refs).toEqual(
      expect.arrayContaining([
        "dist/index.js",
        "dist/index.d.ts",
        "bin/praxis-ba.cjs",
        "tools/session-bootstrap.mjs",
      ]),
    );
  });
});
