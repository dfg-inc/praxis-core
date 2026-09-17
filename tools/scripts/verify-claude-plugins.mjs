#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { extractLeadingFrontmatter } from "./validate-plugins.mjs";
import { parse as yamlParse } from "yaml";
import { PLUGINS, claudePluginsDir } from "./pack-claude-plugins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`verify-claude-plugins: ${msg}`);
  process.exit(1);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      if (!existsSync(abs)) fail(`broken symlink ${abs}`);
      continue;
    }
    if (st.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

export function verifyClaudePlugins(version) {
  const dir = claudePluginsDir(version);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== version) fail(`manifest version ${manifest.version} != ${version}`);
  const tmp = mkdtempSync(join(tmpdir(), "praxis-plugin-"));
  const proven = [];
  try {
    for (const plugin of PLUGINS) {
      const zip = join(dir, `${plugin.id}.zip`);
      if (!existsSync(zip)) fail(`missing ${zip}`);
      const unpack = join(tmp, plugin.id);
      mkdirSync(unpack, { recursive: true });
      const unzip = spawnSync("unzip", ["-q", zip, "-d", unpack], { encoding: "utf8" });
      if ((unzip.status ?? 1) !== 0) fail(`invalid zip ${zip}\n${unzip.stderr}`);
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
      JSON.parse(JSON.stringify(pluginJson));
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
      const runtimeCli = join(unpack, "runtime", "node_modules", "@praxis", "cli", "dist", "main.js");
      if (!existsSync(runtimeCli)) fail(`missing bundled runtime ${runtimeCli}`);
      const files = walk(unpack);
      for (const f of files) {
        const rel = f.slice(unpack.length);
        if (rel.includes("node_modules")) continue;
        if (rel.includes("/.env") || /(^|\/)\.env(\.|$)/.test(rel)) fail(`secret-like file ${rel}`);
        const buf = readFileSync(f);
        if (buf.includes(Buffer.from("PRAXIS_JIRA_TOKEN=")) && !rel.endsWith(".md")) {
          const text = buf.toString("utf8");
          if (/PRAXIS_JIRA_TOKEN=\S+/.test(text) && !text.includes("<redacted>")) {
            fail(`token-like content in ${rel}`);
          }
        }
        if (buf.toString("utf8").includes("/Users/")) {
          fail(`absolute /Users path in ${rel}`);
        }
      }
      const help = spawnSync(bin, ["--help"], {
        encoding: "utf8",
        env: { ...process.env, PRAXIS_SKIP_DOTENV: "1" },
      });
      if ((help.status ?? 1) !== 0) fail(`${plugin.id} praxis --help failed\n${help.stderr}`);
      if (!help.stdout.includes("praxis")) fail(`${plugin.id} help empty`);
      const ver = spawnSync(bin, ["--version"], {
        encoding: "utf8",
        env: { ...process.env, PRAXIS_SKIP_DOTENV: "1" },
      });
      if ((ver.stdout ?? "").trim() !== version) {
        fail(`${plugin.id} praxis --version ${(ver.stdout ?? "").trim()} != ${version}`);
      }
      const fake = mkdtempSync(join(tmp, `${plugin.id}-ws-`));
      const roleHelp = spawnSync(bin, ["architect", "--help"], {
        cwd: fake,
        encoding: "utf8",
        env: { ...process.env, PRAXIS_SKIP_DOTENV: "1" },
      });
      if ((roleHelp.status ?? 1) !== 0) fail(`${plugin.id} role help failed`);
    }
    proven.push(
      "valid Claude plugin manifests",
      "skills packaged",
      "prompt templates packaged",
      "self-contained Praxis runtime",
      "public CLI help",
      "public CLI JSON mode",
      "no absolute paths",
      "no secrets",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return {
    ok: true,
    source: "release-bundles",
    version,
    plugins: PLUGINS.map((p) => p.title),
    proven,
    pending: ["manual Claude UI import"],
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
