#!/usr/bin/env node
/**
 * Local tgz pack + external consumer install.
 * Does not embed host absolute paths into published package.json files.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const SHARED_WORKSPACES = [
  "@praxis/contracts",
  "@praxis/project-config",
  "@praxis/knowledge",
  "@praxis/plugin-sdk",
  "@praxis/cli",
];
// @praxis/mcp is internal to hosted Claude plugin bundling and is not independently packed.

export const PLUGIN_WORKSPACES = [
  "@praxis/ba",
  "@praxis/architect",
  "@praxis/developer",
  "@praxis/jira",
  "@praxis/quality",
];

export const ALL_WORKSPACES = [...SHARED_WORKSPACES, ...PLUGIN_WORKSPACES];

export function tarballFileName(workspace, version) {
  const short = workspace.replace(/^@/, "").replace("/", "-");
  return `${short}-${version}.tgz`;
}

export function expectedTarballNames(version) {
  return ALL_WORKSPACES.map((w) => tarballFileName(w, version));
}

export function localPackagesDir(root, version) {
  return join(root, "dist", "local-packages", version);
}

function fail(msg) {
  console.error(`local-packages: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd, extraEnv) {
  console.log(`$ ${cmd}`);
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    env: extraEnv ?? process.env,
  });
  if ((r.status ?? 1) !== 0) {
    fail(`command failed: ${cmd}\n${r.stderr || r.stdout}`);
  }
  return r;
}

export function packReleaseLocal(root, version) {
  if (!version) fail("version required");
  run("npm run build", root);
  const dest = localPackagesDir(root, version);
  mkdirSync(dest, { recursive: true });
  for (const ws of ALL_WORKSPACES) {
    run(
      `npm pack -w ${ws} --pack-destination ${JSON.stringify(dest)}`,
      root,
    );
  }
  const missing = expectedTarballNames(version).filter(
    (n) => !existsSync(join(dest, n)),
  );
  if (missing.length) fail(`missing tarballs: ${missing.join(", ")}`);
  console.log(`packed tgz -> ${dest}`);
  return dest;
}

function mergeFileDeps(pkg, destRel, version) {
  const deps = { ...(pkg.dependencies ?? {}) };
  for (const ws of ALL_WORKSPACES) {
    deps[ws] = `file:${join(destRel, tarballFileName(ws, version))}`;
  }
  return { ...pkg, dependencies: deps };
}

export function installTest({ root, version, testRepo }) {
  if (!version || !testRepo) fail("install-test requires version and testRepo");
  const dest = localPackagesDir(root, version);
  if (!existsSync(dest)) fail(`missing ${dest}; run release-local first`);
  const expected = expectedTarballNames(version);
  const missing = expected.filter((n) => !existsSync(join(dest, n)));
  if (missing.length) fail(`incomplete pack; missing ${missing.join(", ")}`);

  mkdirSync(testRepo, { recursive: true });
  const tgzDir = join(testRepo, ".praxis-local-tgz");
  mkdirSync(tgzDir, { recursive: true });
  for (const name of expected) {
    copyFileSync(join(dest, name), join(tgzDir, name));
  }

  const pkgPath = join(testRepo, "package.json");
  const pkg = existsSync(pkgPath)
    ? JSON.parse(readFileSync(pkgPath, "utf8"))
    : { name: "praxis-external-consumer", private: true, type: "module" };
  const next = mergeFileDeps(pkg, ".praxis-local-tgz", version);
  writeFileSync(pkgPath, `${JSON.stringify(next, null, 2)}\n`);
  writeFileSync(
    join(testRepo, ".npmrc"),
    "@praxis:registry=https://npm.praxis.invalid\n",
  );

  const env = { ...process.env };
  delete env.PRAXIS_JIRA_TOKEN;
  delete env.PRAXIS_JIRA_EMAIL;
  run("npm install --no-fund --no-audit", testRepo, env);
  return validateInstall(testRepo, version);
}

export function validateInstall(testRepo, version) {
  const ls = spawnSync("npm ls --depth=0 --json", {
    cwd: testRepo,
    shell: true,
    encoding: "utf8",
  });
  const parsed = JSON.parse(ls.stdout || "{}");
  const deps = parsed.dependencies ?? {};
  const missing = [];
  for (const ws of ALL_WORKSPACES) {
    const d = deps[ws];
    if (!d || d.version !== version) missing.push(`${ws}@${version}`);
  }
  if (missing.length) {
    fail(`npm ls missing ${missing.join(", ")}\n${ls.stdout}`);
  }
  for (const id of ["ba", "architect", "developer", "quality"]) {
    const pluginJson = join(
      testRepo,
      "node_modules",
      "@praxis",
      id,
      ".claude-plugin",
      "plugin.json",
    );
    if (!existsSync(pluginJson)) fail(`missing ${pluginJson}`);
    JSON.parse(readFileSync(pluginJson, "utf8"));
  }
  const jiraMain = join(testRepo, "node_modules/@praxis/jira/dist/index.js");
  if (!existsSync(jiraMain)) fail(`missing Jira entry ${jiraMain}`);
  const qualityPkg = join(testRepo, "node_modules/@praxis/quality/package.json");
  if (!existsSync(qualityPkg)) fail(`missing ${qualityPkg}`);
  const smoke = spawnSync(
    `node --input-type=module -e "import '@praxis/contracts'; import '@praxis/jira'; import '@praxis/plugin-sdk'; import '@praxis/cli'; console.log('imports-ok')"`,
    { cwd: testRepo, shell: true, encoding: "utf8" },
  );
  if ((smoke.status ?? 1) !== 0) {
    fail(`import smoke failed\n${smoke.stderr || smoke.stdout}`);
  }
  const cliBin = join(testRepo, "node_modules/@praxis/cli/dist/main.js");
  if (!existsSync(cliBin)) fail(`missing CLI entry ${cliBin}`);
  console.log(`install-test PASS version=${version} repo=${testRepo}`);
  return { ok: true, version, testRepo };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const root = resolve(dirname(thisFile), "../..");
  const flag = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (cmd === "pack") packReleaseLocal(root, flag("--version"));
  else if (cmd === "install")
    installTest({
      root,
      version: flag("--version"),
      testRepo: flag("--repo"),
    });
  else fail("usage: local-packages.mjs pack|install --version X --repo PATH");
}
