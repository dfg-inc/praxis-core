#!/usr/bin/env node
/**
 * Session version check CLI (WBS 8.4) — used by plugin session-start hooks.
 *
 * Usage:
 *   node packages/plugin-sdk/bin/check-version.mjs \
 *     --installed 0.4.0 --published 0.4.1 \
 *     --canon-installed 3 --canon-required 3
 */
import { checkPluginVersion } from "../dist/index.js";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const installed = flag("--installed");
const published = flag("--published");
const installedCanonMajor = Number(flag("--canon-installed") ?? "3");
const requiredCanonMajor = Number(flag("--canon-required") ?? "3");
if (!installed || !published) {
  console.error(
    "usage: check-version --installed <v> --published <v> [--canon-installed N] [--canon-required N] [--source marketplace|local|git]",
  );
  process.exit(2);
}

const result = checkPluginVersion({
  installed,
  published,
  installedCanonMajor,
  requiredCanonMajor,
  installSource: flag("--source") ?? "marketplace",
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.continueAllowed ? 0 : 1);
