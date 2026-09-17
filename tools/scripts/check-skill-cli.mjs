#!/usr/bin/env node
/**
 * Fail if product role Skills teach private Jira/runtime scripts
 * when the public Praxis CLI exists.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROLES = ["ba", "architect", "developer", "quality"];
const FORBIDDEN = [
  /plugins\/jira\/tools\//,
  /jira-workflow\.mjs/,
  /tools\/praxis\.mjs/,
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (name === "SKILL.md") out.push(abs);
  }
  return out;
}

const violations = [];
for (const role of ROLES) {
  for (const file of walk(join(root, "plugins", role, "skills"))) {
    const text = readFileSync(file, "utf8");
    for (const re of FORBIDDEN) {
      if (re.test(text)) {
        violations.push(`${relative(root, file)} matches ${re}`);
      }
    }
  }
}

if (violations.length) {
  console.error("Skill CLI contract failed — private scripts in product Skills:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`Skill CLI contract OK (${ROLES.join(", ")}).`);
