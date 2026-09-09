#!/usr/bin/env node
/**
 * Dry-run remote publication plan for standalone BA/Developer trees.
 * Never creates GitLab/GitHub repositories or pushes.
 *
 *   node tools/scripts/publish-standalone-remote.mjs --component ba --dry-run
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportStandalone, praxisVersion } from "./export-standalone.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("-")) {
    return process.argv[i + 1];
  }
  return fallback;
}

const dryRun = process.argv.includes("--dry-run") || !process.argv.includes("--push");
const component = arg("--component", "ba");

if (component !== "ba" && component !== "developer") {
  console.error("usage: publish-standalone-remote.mjs --component ba|developer --dry-run");
  process.exit(2);
}

if (!dryRun) {
  console.error("refusing live push — pass only --dry-run (remote write needs explicit permission)");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), `praxis-publish-${component}-`));
try {
  const { dest, manifest } = exportStandalone(component, dir);
  const checks = {
    README: existsSync(join(dest, "README.md")),
    LICENSE: existsSync(join(dest, "LICENSE")),
    gitignore: existsSync(join(dest, ".gitignore")),
    package: existsSync(join(dest, "package.json")),
    ci: existsSync(join(dest, ".github/workflows/ci.yml")),
    publication: existsSync(join(dest, "PUBLICATION.md")),
    manifest: existsSync(join(dest, "praxis-standalone-manifest.json")),
  };
  const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
  const ok = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify(
      {
        ok,
        dryRun: true,
        wouldPush: false,
        component,
        canonicalName: `praxis-${component}`,
        version: praxisVersion(),
        packageName: pkg.name,
        sourceCommit: manifest.sourceCommit,
        nextAction: `Create empty remote repository praxis-${component} with explicit permission, then git push the exported tree`,
        checks,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
