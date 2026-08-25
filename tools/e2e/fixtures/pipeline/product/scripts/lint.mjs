#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const NEEDLE = ["FIXME", "CRITICAL"].join("-");

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith(".js") || ent.name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

const root = join(import.meta.dirname, "..");
const files = walk(join(root, "src"));
for (const f of files) {
  const text = readFileSync(f, "utf8");
  if (text.includes(NEEDLE)) {
    console.error(`lint fail: ${f} contains ${NEEDLE}`);
    process.exit(1);
  }
}
console.log("lint ok");
