#!/usr/bin/env node
/**
 * Verify release plugin artifacts are standalone/installable.
 *
 * - Ensures dist/release-mirror plugins exist (builds mirror if missing/forced)
 * - Checks required paths + package.json references
 * - npm pack --dry-run outside the monorepo (avoids root .gitignore dist/ rules)
 * - Installs each tarball into a temp external project and runs runtime smoke
 *
 * Usage:
 *   node tools/scripts/verify-release-artifacts.mjs
 *   node tools/scripts/verify-release-artifacts.mjs --rebuild
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  PLUGIN_IDS,
  REQUIRED_PATHS,
  assertRequiredPaths,
  buildAllPluginArtifacts,
  collectPackagePathRefs,
} from "./package-plugins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mirror = join(root, "dist/release-mirror");
const rebuild = process.argv.includes("--rebuild");
const fullMirror = process.argv.includes("--full-mirror");

function fail(msg) {
  console.error(`verify-release-artifacts: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd, opts = {}) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    env: {
      ...process.env,
      // Prevent accidental workspace resolution against Praxis root.
      npm_config_workspaces: "false",
    },
    ...opts,
  });
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function readJson(abs) {
  return JSON.parse(readFileSync(abs, "utf8"));
}

function ensureArtifacts() {
  const havePlugins = PLUGIN_IDS.every((id) =>
    existsSync(join(mirror, "plugins", id, "package.json")),
  );
  if (fullMirror || (rebuild && !havePlugins)) {
    console.log("$ npm run release:mirror");
    const r = run("npm run release:mirror", root, { stdio: "inherit" });
    if (!r.ok) fail("release:mirror failed");
    return;
  }
  if (rebuild || !havePlugins) {
    console.log("$ buildAllPluginArtifacts");
    mkdirSync(mirror, { recursive: true });
    buildAllPluginArtifacts(mirror);
  }
}

function externalPackDir(pluginId) {
  // Copy artifact outside the monorepo so npm packlist does not apply root
  // .gitignore rules (e.g. ignoring dist/).
  const base = mkdtempSync(join(tmpdir(), `praxis-pack-${pluginId}-`));
  const src = join(mirror, "plugins", pluginId);
  const dest = join(base, pluginId);
  cpSync(src, dest, { recursive: true });
  // Ensure no parent .gitignore influence: write empty .npmignore that does not
  // exclude packaged files; package.json "files" is authoritative.
  writeFileSync(join(dest, ".npmignore"), "# staged artifact — use package.json files\n");
  return { base, dest };
}

function packDryRun(pluginDir) {
  const r = run("npm pack --dry-run --json", pluginDir);
  if (!r.ok) {
    return { ok: false, error: r.stderr || r.stdout, files: [] };
  }
  let files = [];
  try {
    const parsed = JSON.parse(r.stdout.trim() || "[]");
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    files = (entry?.files ?? []).map((f) => f.path ?? f);
  } catch {
    // Fallback: parse classic npm pack text output
    files = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("npm ") && !l.endsWith(".tgz"));
  }
  return { ok: true, files, raw: r.stdout };
}

function assertPackContains(pluginId, files) {
  const required = REQUIRED_PATHS[pluginId] ?? [];
  const missing = [];
  for (const rel of required) {
    const hit = files.some(
      (f) => f === rel || f.startsWith(rel.replace(/\/$/, "") + "/"),
    );
    if (!hit) missing.push(rel);
  }
  return missing;
}

function smokePlugin(pluginId, installDir) {
  const results = [];
  if (pluginId === "ba") {
    const cli = run("node ./bin/praxis-ba.cjs", installDir);
    // Expect usage error without --repo, but binary must execute.
    const ran =
      cli.stdout.includes("VERIFY-FAIL") ||
      cli.stderr.includes("VERIFY-FAIL") ||
      cli.stdout.includes("--repo") ||
      cli.stderr.includes("--repo");
    results.push({
      name: "praxis-ba.cjs executes",
      ok: ran,
      detail: (cli.stdout + cli.stderr).slice(0, 400),
    });
    const boot = run("node ./tools/session-bootstrap.cjs", installDir);
    results.push({
      name: "session-bootstrap",
      ok: boot.ok || boot.stdout.length > 0,
      detail: (boot.stdout + boot.stderr).slice(0, 400),
    });
  } else if (pluginId === "architect" || pluginId === "developer") {
    const boot = run("node ./tools/session-bootstrap.cjs", installDir);
    results.push({
      name: "session-bootstrap",
      ok: boot.ok || boot.stdout.length > 0,
      detail: (boot.stdout + boot.stderr).slice(0, 400),
    });
    if (pluginId === "architect") {
      const tool = join(installDir, "tools/build-architecture-package.mjs");
      results.push({
        name: "build-architecture-package present",
        ok: existsSync(tool),
      });
    }
    if (pluginId === "developer") {
      for (const t of ["final-arbiter.mjs", "run-work-package.mjs"]) {
        results.push({
          name: `${t} present`,
          ok: existsSync(join(installDir, "tools", t)),
        });
      }
    }
  } else if (pluginId === "jira") {
    const r = run(
      `node --input-type=module -e "import { JiraClient } from './dist/index.js'; if (typeof JiraClient !== 'function') process.exit(2); console.log('JiraClient ok')"`,
      installDir,
    );
    results.push({
      name: "import JiraClient from dist",
      ok: r.ok && r.stdout.includes("JiraClient ok"),
      detail: (r.stdout + r.stderr).slice(0, 400),
    });
  }
  return results;
}

function installAndSmoke(pluginId) {
  const { base, dest } = externalPackDir(pluginId);
  try {
    const dry = packDryRun(dest);
    if (!dry.ok) fail(`${pluginId}: npm pack --dry-run failed: ${dry.error}`);
    const missingPack = assertPackContains(pluginId, dry.files);
    if (missingPack.length) {
      fail(
        `${pluginId}: npm pack missing paths: ${missingPack.join(", ")}\npacked: ${dry.files.slice(0, 40).join(", ")}`,
      );
    }

    const pack = run("npm pack", dest);
    if (!pack.ok) fail(`${pluginId}: npm pack failed: ${pack.stderr}`);
    const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
    if (!tgz) fail(`${pluginId}: no tarball produced`);

    const consumer = mkdtempSync(join(tmpdir(), `praxis-consumer-${pluginId}-`));
    writeJsonSafe(join(consumer, "package.json"), {
      name: `praxis-consumer-${pluginId}`,
      private: true,
      type: "module",
    });
    const install = run(`npm install "${join(dest, tgz)}"`, consumer);
    if (!install.ok) {
      fail(`${pluginId}: npm install into external consumer failed:\n${install.stderr}`);
    }

    // Prefer the installed package path under node_modules/@praxis/<name>
    const pkg = readJson(join(dest, "package.json"));
    const installed = join(consumer, "node_modules", ...pkg.name.split("/"));
    if (!existsSync(installed)) {
      fail(`${pluginId}: installed package path missing: ${installed}`);
    }

    // Guard: installed tree must not resolve back into monorepo plugins/ via symlink to source.
    const real = spawnSync("node", ["-e", `console.log(require('fs').realpathSync(${JSON.stringify(installed)}))`], {
      encoding: "utf8",
    });
    const realPath = (real.stdout || "").trim();
    if (realPath.includes(join(root, "plugins"))) {
      fail(`${pluginId}: installed path resolves into monorepo plugins/: ${realPath}`);
    }

    const smokes = smokePlugin(pluginId, installed);
    const failed = smokes.filter((s) => !s.ok);
    if (failed.length) {
      fail(
        `${pluginId}: runtime smoke failed:\n${JSON.stringify(failed, null, 2)}`,
      );
    }

    rmSync(consumer, { recursive: true, force: true });
    return { packFiles: dry.files.length, smokes };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function writeJsonSafe(abs, data) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
}

function main() {
  ensureArtifacts();

  // Path + package.json reference checks against mirror tree
  for (const id of PLUGIN_IDS) {
    const dir = join(mirror, "plugins", id);
    const missing = assertRequiredPaths(dir, id);
    if (missing.length) {
      // Attempt rebuild once if stale mirror from old script
      console.warn(`stale mirror for ${id}, rebuilding…`);
      buildAllPluginArtifacts(mirror);
      const missing2 = assertRequiredPaths(dir, id);
      if (missing2.length) fail(`${id}: missing ${missing2.join(", ")}`);
    }
    const pkg = readJson(join(dir, "package.json"));
    const refs = collectPackagePathRefs(pkg);
    const missingRefs = refs.filter((r) => !existsSync(join(dir, r)));
    if (missingRefs.length) {
      fail(`${id}: package refs missing: ${missingRefs.join(", ")}`);
    }
    if (pkg.dependencies) {
      const praxisDeps = Object.keys(pkg.dependencies).filter((n) =>
        n.startsWith("@praxis/"),
      );
      if (praxisDeps.length) {
        fail(
          `${id}: staged package still depends on ${praxisDeps.join(", ")} — must be bundled`,
        );
      }
    }
  }

  const report = {};
  for (const id of PLUGIN_IDS) {
    console.log(`\n=== verify ${id} ===`);
    report[id] = installAndSmoke(id);
    console.log(`ok ${id}: packFiles=${report[id].packFiles}`);
  }

  console.log(JSON.stringify({ ok: true, report }, null, 2));
}

main();
