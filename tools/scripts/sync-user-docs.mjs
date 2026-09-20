#!/usr/bin/env node
/**
 * Copy canonical docs/user into the Marketplace site so both surfaces
 * ship the same Markdown. VitePress docs-site reads docs/user directly.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = join(root, "docs/user");
const dest = join(root, "apps/marketplace-site/docs/user-guide");

if (!existsSync(src)) {
  console.error("missing docs/user");
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`synced ${src} -> ${dest}`);
