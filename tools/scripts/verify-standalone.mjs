#!/usr/bin/env node
/**
 * Drift/structure gate for standalone BA + Developer exports.
 *
 *   node tools/scripts/verify-standalone.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportStandalone,
  praxisVersion,
  scanStandaloneLeaks,
  STANDALONE_SCHEMA_VERSION,
} from "./export-standalone.mjs";
import { existsSync, readFileSync } from "node:fs";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const version = praxisVersion();
const base = mkdtempSync(join(tmpdir(), "praxis-verify-standalone-"));

try {
  const ba = exportStandalone("ba", join(base, "ba"));
  const dev = exportStandalone("developer", join(base, "developer"));

  for (const { component, result, required } of [
    {
      component: "ba",
      result: ba,
      required: [
        "package.json",
        "praxis-standalone-manifest.json",
        "tools/session-bootstrap.mjs",
        "canon-graph/bin/praxis-ba.mjs",
        "canon-graph/package.json",
        "skills/session-start/SKILL.md",
        "LICENSE",
        "vendor",
        "PUBLICATION.md",
        ".github/workflows/ci.yml",
      ],
    },
    {
      component: "developer",
      result: dev,
      required: [
        "package.json",
        "praxis-standalone-manifest.json",
        "tools/session-bootstrap.mjs",
        "tools/developer-governance.mjs",
        "test/developer-governance.test.mjs",
        "skills/session-start/SKILL.md",
        "LICENSE",
        "vendor",
        "PUBLICATION.md",
        ".github/workflows/ci.yml",
      ],
    },
  ]) {
    const m = result.manifest;
    if (m.schemaVersion !== STANDALONE_SCHEMA_VERSION) fail(`${component} schema`);
    if (m.version !== version) fail(`${component} version drift ${m.version} != ${version}`);
    if (m.component !== component) fail(`${component} manifest component`);
    if (!m.sourceCommit || m.sourceCommit === "unknown") {
      fail(`${component} missing sourceCommit`);
    }
    if (m.generatedFrom !== "praxis-monorepo") fail(`${component} generatedFrom`);
    for (const rel of required) {
      if (!existsSync(join(result.dest, rel))) fail(`${component} missing ${rel}`);
    }
    const pkg = JSON.parse(readFileSync(join(result.dest, "package.json"), "utf8"));
    if (pkg.version !== version) fail(`${component} package.json version`);
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith("@praxis/") && (range === "*" || !String(range).startsWith("file:./vendor/"))) {
        fail(`${component} dep ${name} is not a vendor tgz pin (${range})`);
      }
    }
    const leaks = scanStandaloneLeaks(result.dest);
    if (leaks.length) fail(`${component} leaks: ${JSON.stringify(leaks)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        version,
        ba: ba.manifest,
        developer: dev.manifest,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}
