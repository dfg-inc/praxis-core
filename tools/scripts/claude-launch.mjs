#!/usr/bin/env node
/**
 * Launch Claude Code for a Praxis role. No secrets in logs.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROLES = {
  ba: { pkg: "@praxis/ba", prompt: "plugins/ba/prompts/jira-role.md" },
  architect: {
    pkg: "@praxis/architect",
    prompt: "plugins/architect/prompts/jira-role.md",
  },
  developer: {
    pkg: "@praxis/developer",
    prompt: "plugins/developer/prompts/jira-role.md",
  },
  qa: { pkg: "@praxis/quality", prompt: "plugins/quality/prompts/jira-role.md" },
};

export function redact(text) {
  return String(text ?? "").replace(
    /PRAXIS_JIRA_TOKEN=[^\s]+/g,
    "PRAXIS_JIRA_TOKEN=<redacted>",
  );
}

export function findClaudeBin(env = process.env) {
  const override = env.PRAXIS_CLAUDE_BIN;
  if (override) return override;
  const r = spawnSync("sh", ["-c", "command -v claude"], {
    encoding: "utf8",
    env: { PATH: env.PATH || "" },
  });
  const path = (r.stdout ?? "").trim();
  return path || null;
}

function fail(msg) {
  throw new Error(msg);
}

export function requiredJiraEnv(env = process.env) {
  const mode = env.PRAXIS_JIRA_MODE ?? "cloud";
  const base = ["PRAXIS_JIRA_MODE", "PRAXIS_JIRA_BASE_URL", "PRAXIS_JIRA_PROJECT_KEY", "PRAXIS_JIRA_TOKEN"];
  if (mode === "cloud") base.push("PRAXIS_JIRA_EMAIL");
  return base.filter((k) => !env[k]);
}

export function pluginDir(repo, role) {
  return join(repo, "node_modules", ROLES[role].pkg);
}

export function renderPrompt(root, role, vars) {
  const file = join(root, ROLES[role].prompt);
  let text = existsSync(file)
    ? readFileSync(file, "utf8")
    : `Praxis ${role} role. Epic={{EPIC}} WP={{WP}} Repo={{REPO}}`;
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{{${k}}}`, String(v ?? ""));
  }
  return text;
}

export function launchRole(opts) {
  const repo = resolve(opts.repo);
  const role = opts.role;
  const bin = findClaudeBin(opts.env ?? process.env);
  if (!bin) {
    fail(
      "Claude Code executable not found.\nInstall/configure Claude Code before running Praxis role commands.\nOverride with PRAXIS_CLAUDE_BIN=/path/to/claude",
    );
  }
  const missing = requiredJiraEnv(opts.env ?? process.env);
  if (missing.length) {
    fail(`missing required Jira env: ${missing.join(", ")} (token not printed)`);
  }
  const dir = pluginDir(repo, role);
  const pluginJson = join(dir, ".claude-plugin", "plugin.json");
  if (!existsSync(pluginJson)) {
    fail(
      `Praxis ${role} plugin is not installed in target repository (${dir}).\nRun:\nmake install-test VERSION=<ver> TEST_REPO=${repo}`,
    );
  }
  const prompt = renderPrompt(opts.praxisRoot, role, {
    EPIC: opts.epic ?? "",
    WP: opts.wp ?? "",
    REPO: repo,
  });
  const args = ["--plugin-dir", dir, prompt];
  if (opts.dryLaunch) {
    return { bin, cwd: repo, args, env: opts.env ?? process.env, prompt };
  }
  const r = spawnSync(bin, args, {
    cwd: repo,
    stdio: "inherit",
    env: opts.env ?? process.env,
  });
  if ((r.status ?? 1) !== 0) {
    fail(redact(`Claude Code exited ${r.status ?? 1}`));
  }
  return { bin, cwd: repo, args };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  fail("use tools/praxis.mjs ba|architect|developer|qa");
}
