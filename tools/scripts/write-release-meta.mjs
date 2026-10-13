#!/usr/bin/env node
/**
 * Write dist/release-meta.json for the Core vendor GitHub Release.
 *
 * The source SHA is the checked-out commit (git rev-parse HEAD), so a
 * workflow_dispatch that checks out an existing tag records that tag's
 * commit rather than the later workflow commit.
 *
 * Env:
 *   GITHUB_REF_NAME or CI_COMMIT_TAG — must be v${package.json version}
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_TAG || `v${version}`;
const expected = `v${version}`;
if (tag !== expected && tag !== version) {
  throw new Error(`tag must match package.json version: got ${tag}, expected ${expected}`);
}

const checksumPath = join(root, "dist", "vendor-checksums.json");
if (!existsSync(checksumPath)) {
  throw new Error(`missing ${checksumPath}; run pack:vendor and the checksum step first`);
}
const checksumBytes = readFileSync(checksumPath);
const checksums = JSON.parse(checksumBytes.toString("utf8"));
if (checksums.version !== version) {
  throw new Error(`vendor-checksums version ${checksums.version} != package.json ${version}`);
}

const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const tagSha = execFileSync("git", ["rev-parse", `${tag}^{commit}`], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (sourceSha !== tagSha) {
  throw new Error(`refusing to publish ${tag}: HEAD ${sourceSha} is not tag commit ${tagSha}`);
}

const meta = {
  schemaVersion: 1,
  product: "praxis-core",
  version,
  tag,
  sourceSha,
  repository: "https://github.com/dfg-inc/praxis-core",
  artifact: {
    file: "vendor-checksums.json",
    path: checksumPath,
    sha256: createHash("sha256").update(checksumBytes).digest("hex"),
    bytes: checksumBytes.length,
    kind: "vendor",
    packages: checksums.packages,
  },
  compatibility: {
    productVersion: version,
    packageJsonVersion: pkg.version,
    engines: pkg.engines || {},
    installModel: "npm vendor tarballs for Praxis Runtime and role plugins",
    requires: [],
    notes:
      "Nine @praxis/* tarballs plus vendor-checksums.json. Consumers pin these files; this release does not install a Claude Desktop extension.",
  },
  publishedAt: new Date().toISOString(),
};

mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", "release-meta.json");
writeFileSync(out, JSON.stringify(meta, null, 2) + "\n");
console.log(`wrote ${out}`);
console.log(`sourceSha ${sourceSha}`);
console.log(`checksums ${meta.artifact.sha256}`);
