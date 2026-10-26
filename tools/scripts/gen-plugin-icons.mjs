#!/usr/bin/env node
/**
 * Writes the square plugin icons (512x512 PNG, no external tools) into each plugin's .claude-plugin/icon.png.
 * A rounded square in the role's color with a white "P". Re-run to regenerate; the PNGs are committed.
 *   node tools/scripts/gen-plugin-icons.mjs [--split-root <dir containing the repositories>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const splitRoot = resolve(argv.includes("--split-root") ? argv[argv.indexOf("--split-root") + 1] : join(here, "../../.."));
const SIZE = 512;
const targets = [
  ["praxis-runtime/plugins/runtime", [0x33, 0x41, 0x55]],
  ["praxis-ba/plugins/ba", [0x0d, 0x94, 0x88]],
  ["praxis-architect/plugins/architect", [0xd9, 0x77, 0x06]],
  ["praxis-developer/plugins/developer", [0x25, 0x63, 0xeb]],
  ["praxis-quality/plugins/quality", [0x16, 0xa3, 0x4a]],
  ["praxis-marketplace/plugins/praxis", [0x4f, 0x46, 0xe5]],
];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const inRoundedSquare = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), SIZE - r);
  const cy = Math.min(Math.max(y, r), SIZE - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// the letter P: a stem and a bowl (a ring with the left side removed)
function inLetter(x, y) {
  const stem = x >= 150 && x <= 226 && y >= 118 && y <= 394;
  const cx = 262;
  const cy = 224;
  const d = Math.hypot(x - cx, y - cy);
  const bowl = d <= 106 && d >= 36 && x >= 226;
  const top = y >= 118 && y <= 150 && x >= 226 && x <= cx;
  const mid = y >= 298 - 106 + 106 - 32 && false;
  return stem || bowl || top || mid;
}
function png(color) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  const SS = 2;
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0;
    for (let x = 0; x < SIZE; x += 1) {
      let cover = 0;
      let letter = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (inRoundedSquare(px, py, 96)) cover += 1;
          if (inLetter(px, py)) letter += 1;
        }
      }
      const a = cover / (SS * SS);
      const l = letter / (SS * SS);
      const o = y * (SIZE * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(color[0] * (1 - l) + 255 * l);
      raw[o + 1] = Math.round(color[1] * (1 - l) + 255 * l);
      raw[o + 2] = Math.round(color[2] * (1 - l) + 255 * l);
      raw[o + 3] = Math.round(255 * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
for (const [dir, color] of targets) {
  const out = join(splitRoot, dir, ".claude-plugin", "icon.png");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png(color));
  console.log(`wrote ${out}`);
}
