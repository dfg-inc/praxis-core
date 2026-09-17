#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { extractLeadingFrontmatter } from "./validate-plugins.mjs";
import { parse as yamlParse } from "yaml";
import {
  MANIFEST_CONTRACT,
  PLUGINS,
  distClaudePluginsDir,
} from "./claude-plugins-shared.mjs";
import { extractZip, inspectZipEntries, parseZip } from "./claude-zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`verify-claude-plugins: ${msg}`);
  process.exit(1);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function cleanEnv(home) {
  const nodeDir = dirname(process.execPath);
  return {
    PATH: `${nodeDir}:/usr/bin:/bin`,
    PRAXIS_SKIP_DOTENV: "1",
    HOME: home,
    TMPDIR: home,
    LANG: "C",
    NODE_ENV: "test",
  };
}

function runBin(bin, args, cwd) {
  return spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: cleanEnv(cwd),
  });
}

function scanUnpackedFiles(unpack) {
  const stack = [unpack];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = abs.slice(unpack.length).replace(/\\/g, "/");
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (rel.includes("/.env") || /(^|\/)\.env(\.|$)/.test(rel)) {
        fail(`secret-like file ${rel}`);
      }
      const buf = readFileSync(abs);
      const text = buf.toString("utf8");
      if (buf.includes(Buffer.from("PRAXIS_JIRA_TOKEN="))) {
        if (/PRAXIS_JIRA_TOKEN=\S+/.test(text) && !text.includes("<redacted>")) {
          fail(`token-like content in ${rel}`);
        }
      }
      if (text.includes("/Users/")) {
        fail(`absolute /Users path in ${rel}`);
      }
    }
  }
}

export function verifyClaudePluginZip(zipPath, plugin, version, tmp) {
  if (!existsSync(zipPath)) fail(`missing ${zipPath}`);
  const buf = readFileSync(zipPath);
  parseZip(buf);
  const inspected = inspectZipEntries(buf);
  if (inspected.issues.length) {
    fail(`${plugin.id}\n${inspected.issues.join("\n")}`);
  }
  for (const e of inspected.entries) {
    if (e.name === "bin/praxis" && (e.mode & 0o111) === 0) {
      fail(`${plugin.id} bin/praxis is not executable in ZIP metadata`);
    }
  }
  const unpack = join(tmp, plugin.id);
  mkdirSync(unpack, { recursive: true });
  extractZip(buf, unpack);

  const pluginJsonPath = join(unpack, ".claude-plugin", "plugin.json");
  if (!existsSync(pluginJsonPath)) {
    fail(`plugin.json not at ZIP root for ${plugin.id}`);
  }
  if (existsSync(join(unpack, plugin.id, ".claude-plugin", "plugin.json"))) {
    fail(`${plugin.id} zip has an extra directory wrapping the plugin`);
  }
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  if (pluginJson.version !== version) {
    fail(`${plugin.id} plugin.json version ${pluginJson.version} != ${version}`);
  }
  if (!existsSync(join(unpack, "VERSION"))) fail(`missing VERSION in ${plugin.id}`);
  const versionFile = readFileSync(join(unpack, "VERSION"), "utf8").trim();
  if (versionFile !== version) {
    fail(`${plugin.id} VERSION ${versionFile} != ${version}`);
  }
  if (!existsSync(join(unpack, "README.md"))) fail(`missing README.md in ${plugin.id}`);
  if (!existsSync(join(unpack, "runtime", "praxis-runtime.cjs"))) {
    fail(`missing bundled runtime in ${plugin.id}`);
  }
  if (existsSync(join(unpack, "runtime", "node_modules"))) {
    fail(`${plugin.id} contains runtime/node_modules`);
  }

  for (const skill of plugin.requiredSkills) {
    const skillMd = join(unpack, "skills", skill, "SKILL.md");
    if (!existsSync(skillMd)) fail(`missing skill ${skillMd}`);
    const raw = readFileSync(skillMd, "utf8");
    const fm = extractLeadingFrontmatter(raw);
    if (!fm || fm.error) fail(`SKILL.md parse failed ${skillMd}: ${fm?.error}`);
    yamlParse(fm.yaml);
  }
  const prompts = join(unpack, "prompts");
  if (!existsSync(prompts) || readdirSync(prompts).length === 0) {
    fail(`missing prompts in ${plugin.id}`);
  }
  const bin = join(unpack, "bin", "praxis");
  if (!existsSync(bin)) fail(`missing ${bin}`);

  scanUnpackedFiles(unpack);

  const ver = runBin(bin, ["--version"], unpack);
  if ((ver.status ?? 1) !== 0) {
    fail(`${plugin.id} praxis --version failed\n${ver.stderr || ver.stdout}`);
  }
  if ((ver.stdout ?? "").trim() !== version) {
    fail(`${plugin.id} praxis --version ${(ver.stdout ?? "").trim()} != ${version}`);
  }
  const help = runBin(bin, ["--help"], unpack);
  if ((help.status ?? 1) !== 0) {
    fail(`${plugin.id} praxis --help failed\n${help.stderr || help.stdout}`);
  }
  if (!help.stdout.includes("praxis")) fail(`${plugin.id} help empty`);

  for (const args of plugin.helpCommands) {
    const roleHelp = runBin(bin, args, unpack);
    if ((roleHelp.status ?? 1) !== 0) {
      fail(
        `${plugin.id} ${args.join(" ")} failed\n${roleHelp.stderr || roleHelp.stdout}`,
      );
    }
  }

  const fake = mkdtempSync(join(tmp, `${plugin.id}-ws-`));
  writeFileSync(join(fake, "README.md"), "external-workspace\n");
  const template = join(fake, ".empty-git-template");
  mkdirSync(template, { recursive: true });
  const git = spawnSync("git", ["init", "--template", template], {
    cwd: fake,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TEMPLATE_DIR: template,
      HOME: fake,
    },
  });
  rmSync(template, { recursive: true, force: true });
  if ((git.status ?? 1) !== 0) {
    writeFileSync(join(fake, ".praxis-external-workspace"), "1\n");
  }

  const fakeVer = runBin(bin, ["--version"], fake);
  if ((fakeVer.stdout ?? "").trim() !== version) {
    fail(
      `${plugin.id} fake workspace --version ${(fakeVer.stdout ?? "").trim()} != ${version}`,
    );
  }
  const doctor = runBin(bin, ["doctor", "--json"], fake);
  if ((doctor.status ?? 1) !== 0) {
    fail(`${plugin.id} doctor --json failed\n${doctor.stderr || doctor.stdout}`);
  }
  let parsed;
  try {
    parsed = JSON.parse((doctor.stdout ?? "").trim());
  } catch (e) {
    fail(`${plugin.id} doctor --json is not JSON: ${doctor.stdout}\n${e}`);
  }
  if (!parsed || typeof parsed !== "object") {
    fail(`${plugin.id} doctor --json did not return an object`);
  }
  const combined = `${doctor.stdout}\n${doctor.stderr}`;
  if (combined.includes("Cannot find package") || combined.includes("Cannot find module")) {
    fail(`${plugin.id} bundled runtime missing dependency`);
  }
  if (combined.includes("/Users/serg/work/praxis/node_modules")) {
    fail(`${plugin.id} resolved Praxis monorepo node_modules`);
  }

  return {
    file: `${plugin.id}.zip`,
    sha256: sha256File(zipPath),
    bytes: buf.length,
  };
}

export function verifyClaudePlugins(
  version,
  dir = distClaudePluginsDir(root, version),
) {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== version) {
    fail(`manifest version ${manifest.version} != ${version}`);
  }
  if (manifest.contract && manifest.contract !== MANIFEST_CONTRACT) {
    fail(`unexpected manifest contract ${manifest.contract}`);
  }
  const tmpRoot = join(root, "dist", "claude-plugin-verify");
  mkdirSync(tmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(tmpRoot, "praxis-plugin-"));
  try {
    for (const plugin of PLUGINS) {
      const zip = join(dir, `${plugin.id}.zip`);
      const info = verifyClaudePluginZip(zip, plugin, version, tmp);
      const listed = (manifest.plugins || []).find(
        (p) => p.file === `${plugin.id}.zip` || p.id === plugin.id,
      );
      if (!listed) fail(`manifest missing ${plugin.id}`);
      if (listed.sha256 && listed.sha256 !== info.sha256) {
        fail(`${plugin.id} manifest sha256 mismatch`);
      }
      if (listed.version && listed.version !== version) {
        fail(`${plugin.id} manifest version mismatch`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const repoDir = join(root, "claude-plugins");
  const fromRepo = resolve(dir) === resolve(repoDir);
  return {
    ok: true,
    source: fromRepo ? "repository" : "release-bundles",
    version,
    plugins: PLUGINS.map((p) => p.title),
    proven: [
      "bundled runtime",
      "no runtime node_modules",
      "no symlink entries",
      "safe archive paths",
      "deterministic archive structure",
      "valid Claude plugin manifest",
      "skills packaged",
      "public praxis runtime executes",
      "no secrets",
      "no absolute paths",
    ],
    pending: ["manual Claude UI upload"],
  };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--version");
  const version =
    (i >= 0 ? argv[i + 1] : undefined) ||
    process.env.VERSION ||
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const report = verifyClaudePlugins(version);
  console.log(JSON.stringify(report, null, 2));
}
