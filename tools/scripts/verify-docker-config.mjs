#!/usr/bin/env node
/**
 * Static Docker/compose validation (WBS 6.1 image). Runtime `docker build`
 * is attempted only when `docker info` succeeds.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function read(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) fail(`missing ${rel}`);
  return readFileSync(p, "utf8");
}

const qualityDf = read("apps/quality-service/Dockerfile");
for (const needle of [
  "COPY packages/contracts",
  "COPY packages/knowledge",
  "COPY apps/quality-service",
  "EXPOSE 8787",
  "VOLUME [\"/data\"]",
  "CMD [\"node\", \"dist/main.js\"]",
]) {
  if (!qualityDf.includes(needle)) fail(`quality Dockerfile missing ${needle}`);
}

const compose = read("docker-compose.yml");
if (!compose.includes("quality-service:")) fail("compose missing quality-service");
if (!compose.includes("8787:8787")) fail("compose missing quality port");
if (!compose.includes("quality-data:/data")) fail("compose missing persistence volume");
if (!compose.includes("PRAXIS_QUALITY_ALLOWED_ROOT")) {
  fail("compose missing allowed root");
}

const siteDf = read("apps/marketplace-site/Dockerfile");
if (!siteDf.includes("npm run build")) fail("marketplace Dockerfile missing build");
if (!siteDf.includes("4173")) fail("marketplace Dockerfile missing preview port");

const wsDf = read("Dockerfile");
if (!wsDf.includes("COPY packages")) fail("workspace Dockerfile missing packages COPY");
if (!wsDf.includes("CMD [\"npm\", \"run\", \"verify\"]")) {
  fail("workspace Dockerfile missing verify CMD");
}

const info = spawnSync("docker", ["info"], { encoding: "utf8" });
const daemon =
  (info.status ?? 1) === 0
    ? { available: true }
    : {
        available: false,
        reason: (info.stderr || info.stdout || "docker info failed").slice(0, 400),
      };

const report = {
  ok: true,
  static: "pass",
  healthEndpoint: "GET /health",
  daemon,
  runtime: daemon.available ? "attempt" : "pending",
};

if (daemon.available) {
  const build = spawnSync(
    "docker",
    ["compose", "build", "quality-service"],
    { cwd: root, encoding: "utf8" },
  );
  if ((build.status ?? 1) !== 0) {
    report.runtime = "build-failed";
    report.buildError = (build.stderr || build.stdout).slice(0, 800);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  report.runtime = "image-built";
}

console.log(JSON.stringify(report, null, 2));
