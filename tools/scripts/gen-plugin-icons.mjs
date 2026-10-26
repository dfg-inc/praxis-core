#!/usr/bin/env node
/**
 * Writes the square plugin icons (512x512 PNG) into each plugin's .claude-plugin/icon.png.
 *
 * Brand inputs: the Praxis website (praxis-website/site) has no logo mark (its favicon.svg is the Astro
 * framework default, so it is NOT used); it has the warm palette and the Geist type family, and the social
 * artwork (og-praxis.png) shows a lowercase "praxis" wordmark with a dotted "connected team" motif. The icons
 * therefore use a geometric lowercase "p" (stem plus a round bowl, Geist-like) with one small "node" dot,
 * in the website cream (#faf9f5) on a rounded square (22% corner radius, glyph centred, ~60% of the height,
 * readable at 64 px). The role is the background colour, from the website palette
 * (site/src/styles/globals.css): runtime = ink, ba = terracotta, architect = blue-violet,
 * developer = green, quality = amber, praxis (umbrella) = art terracotta.
 * The marketplace repository carries mirror copies of the five role plugins; they are written too.
 *
 * Rendering: headless Chromium through playwright-core (no new dependency; resolved from
 * praxis-runtime/node_modules or this repository). Chromium comes from the Playwright cache, else from
 * /Applications/Google Chrome.app. Re-run to regenerate; the PNGs are committed.
 *   node tools/scripts/gen-plugin-icons.mjs [--split-root <dir containing the repositories>]
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const splitRoot = resolve(argv.includes("--split-root") ? argv[argv.indexOf("--split-root") + 1] : join(here, "../../.."));
const SIZE = 512;
const CREAM = "#faf9f5";

const ROLE = {
  runtime: "#141413",
  ba: "#a34f35",
  architect: "#426879",
  developer: "#46653d",
  quality: "#875b16",
  praxis: "#c0785d",
};
const targets = [
  ["praxis-runtime/plugins/runtime", "runtime"],
  ["praxis-ba/plugins/ba", "ba"],
  ["praxis-architect/plugins/architect", "architect"],
  ["praxis-developer/plugins/developer", "developer"],
  ["praxis-quality/plugins/quality", "quality"],
  ["praxis-marketplace/plugins/praxis", "praxis"],
  // mirror copies kept in the marketplace repository
  ["praxis-marketplace/plugins/praxis-runtime", "runtime"],
  ["praxis-marketplace/plugins/praxis-ba", "ba"],
  ["praxis-marketplace/plugins/praxis-architect", "architect"],
  ["praxis-marketplace/plugins/praxis-developer", "developer"],
  ["praxis-marketplace/plugins/praxis-quality", "quality"],
];

function svgFor(color) {
  // glyph bounding box is x 142..396, y 110..420; shift so it is centred on 256,256
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" rx="${Math.round(SIZE * 0.22)}" fill="${color}"/>
<g transform="translate(-13 -9)" fill="none" stroke="${CREAM}">
<circle cx="266" cy="234" r="96" stroke-width="56"/>
<rect x="142" y="110" width="56" height="310" fill="${CREAM}" stroke="none"/>
<circle cx="372" cy="394" r="24" fill="${CREAM}" fill-opacity=".72" stroke="none"/>
</g>
</svg>`;
}

function loadPlaywright() {
  const candidates = [join(splitRoot, "praxis-runtime/package.json"), join(splitRoot, "praxis-core/package.json"), import.meta.url];
  for (const c of candidates) {
    try {
      return createRequire(c)("playwright-core");
    } catch {
      /* try next */
    }
  }
  throw new Error("playwright-core is not resolvable (expected in praxis-runtime/node_modules)");
}

const { chromium } = loadPlaywright();
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ executablePath: chrome });
}
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
for (const [dir, role] of targets) {
  const out = join(splitRoot, dir, ".claude-plugin");
  if (!existsSync(join(splitRoot, dir))) {
    console.log(`skip (missing) ${dir}`);
    continue;
  }
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}</style>${svgFor(ROLE[role])}`);
  const png = await page.screenshot({ omitBackground: true, type: "png", clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "icon.png"), png);
  console.log(`wrote ${join(dir, ".claude-plugin/icon.png")} (${png.length} bytes)`);
}
await browser.close();
