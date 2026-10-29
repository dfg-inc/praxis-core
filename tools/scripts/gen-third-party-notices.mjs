#!/usr/bin/env node
/**
 * Writes THIRD-PARTY-NOTICES.md: the licence text of every third-party package that is bundled into a Praxis build
 * output (esbuild drops the banners). The list is maintained here; check it against the bundles with
 * `grep -aoE 'node_modules/[^ "]+'` when a dependency changes.
 *
 *   node tools/scripts/gen-third-party-notices.mjs --profile runtime|roles|ba --modules <node_modules dir>
 *        --nested <packages/mcp/node_modules dir> --inlined <dir with <name@version>/package/LICENSE> --out <file>
 *
 * Nothing is relicensed: every entry keeps its own licence and copyright lines verbatim.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const profile = arg("profile");
const modules = arg("modules");
const nested = arg("nested");
const inlined = arg("inlined");
const out = arg("out");
if (!["runtime", "roles", "ba"].includes(profile) || !modules || !out) {
  console.error("usage: --profile runtime|roles|ba --modules <dir> [--nested <dir>] [--inlined <dir>] --out <file>");
  process.exit(2);
}

const common = ["zod", "yaml", "js-yaml", "gray-matter", "extend-shallow", "is-extendable", "kind-of", "section-matter", "strip-bom-string"].map((name) => ({ name, dir: join(modules, name) }));
const runtimeOnly = [
  { name: "zod", dir: nested ? join(nested, "zod") : undefined, note: "(the 4.x copy used by the MCP SDK)" },
  { name: "@modelcontextprotocol/server", dir: join(modules, "@modelcontextprotocol/server") },
  { name: "@modelcontextprotocol/core", dir: join(modules, "@modelcontextprotocol/core") },
  { name: "sql.js", dir: join(modules, "sql.js"), note: "(JavaScript glue and sql-wasm.wasm; the WebAssembly binary embeds SQLite and an Emscripten runtime, whose own terms are not restated in this licence file and were not separately verified)" },
  ...["ajv@8.18.0", "ajv-formats@3.0.1", "fast-uri@3.1.0", "fast-deep-equal@3.1.3", "json-schema-traverse@1.0.0"].map((id) => ({
    name: id.replace(/@[^@]+$/, ""), dir: inlined ? join(inlined, id, "package") : undefined, note: "(inlined by the MCP SDK build)",
  })),
];
const entries = profile === "runtime" ? [...common, ...runtimeOnly] : common;
const here = dirname(fileURLToPath(import.meta.url));

const parts = [];
parts.push(`# Third-party notices

Praxis is licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE). This ${profile === "runtime" ? "Praxis Runtime build output" : "Praxis plugin build output"} bundles the third-party packages (and, for BA, the adapted text) listed below, which keep their own licences. Their copyright and licence texts follow unchanged.
`);
const missing = [];
for (const e of entries) {
  const d = e.dir && resolve(e.dir);
  const pkgFile = d && join(d, "package.json");
  if (!pkgFile || !existsSync(pkgFile)) { missing.push(e.name); continue; }
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  const licFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE.BSD", "license"].map((f) => join(d, f)).find(existsSync);
  if (!licFile) { missing.push(`${e.name} (no licence file)`); continue; }
  parts.push(`---\n\n## ${pkg.name} ${pkg.version}${e.note ? ` ${e.note}` : ""}\n\nDeclared licence: ${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license)}\n\n\`\`\`text\n${readFileSync(licFile, "utf8").replace(/\s+$/, "")}\n\`\`\`\n`);
}
if (profile === "ba") {
  const licFile = join(here, "third-party", "mattpocock-skills.LICENSE");
  parts.push(`---

## Adapted text: the \`grill-me\` skill of mattpocock/skills

The opening paragraph of \`skills/grill-cr/SKILL.md\` (the BA change-request interview) is adapted from the \`grill-me\` skill in https://github.com/mattpocock/skills, which is licensed under the MIT License. The adaptation is not original Praxis text and is not offered under Apache-2.0 as such; the rest of that skill file is Praxis's own. The upstream licence follows unchanged.

\`\`\`text
${readFileSync(licFile, "utf8").replace(/\s+$/, "")}
\`\`\`
`);
}
if (missing.length) { console.error(`missing: ${missing.join(", ")}`); process.exit(1); }
writeFileSync(out, parts.join("\n"));
console.log(`${out}: ${entries.length} packages (${profile})`);
