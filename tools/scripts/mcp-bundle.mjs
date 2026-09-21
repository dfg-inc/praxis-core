import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`mcp-bundle: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd = root) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) fail(`${cmd}\n${r.stderr || r.stdout}`);
  return r;
}

/** Bundle official serveStdio MCP into a single Node 20 CJS file. No node_modules. */
export async function bundlePraxisMcp(outfile, version) {
  const entry = join(root, "packages/mcp/dist/main.js");
  if (!existsSync(entry)) {
    run(
      "npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira -w @praxis/cli -w @praxis/mcp",
    );
  }
  if (!existsSync(entry)) fail(`missing MCP build ${entry}`);
  mkdirSync(dirname(outfile), { recursive: true });
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    legalComments: "none",
    minify: false,
    sourcemap: false,
    logLevel: "silent",
    define: {
      "process.env.PRAXIS_BUNDLE_VERSION": JSON.stringify(version),
    },
    // Quality HTTP service is a sibling CJS file, not inlined (must outlive MCP requests).
    external: [],
  });
  if (!existsSync(outfile)) fail(`esbuild did not write ${outfile}`);
  return outfile;
}

/** Bundle Quality HTTP service next to the MCP runtime. SQLite uses node:sqlite or bundled sql.js WASM. */
export async function bundlePraxisQuality(outfile, version) {
  const entry = join(root, "apps/quality-service/dist/main.js");
  if (!existsSync(entry)) {
    run("npm run build -w @praxis/contracts -w @praxis/knowledge -w @praxis/quality-service");
  }
  if (!existsSync(entry)) fail(`missing Quality service build ${entry}`);
  mkdirSync(dirname(outfile), { recursive: true });
  const wasmSrc = join(root, "node_modules/sql.js/dist/sql-wasm.wasm");
  if (!existsSync(wasmSrc)) fail(`missing sql.js wasm ${wasmSrc}`);
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    legalComments: "none",
    minify: false,
    sourcemap: false,
    logLevel: "silent",
    define: {
      "process.env.PRAXIS_BUNDLE_VERSION": JSON.stringify(version),
    },
  });
  if (!existsSync(outfile)) fail(`esbuild did not write Quality bundle ${outfile}`);
  copyFileSync(wasmSrc, join(dirname(outfile), "sql-wasm.wasm"));
  return outfile;
}
