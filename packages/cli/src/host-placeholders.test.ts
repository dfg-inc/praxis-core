import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorOp, loadPraxisDotenv, scrubUnexpandedPlaceholders } from "./operations.js";

const KEYS = [
  "PRAXIS_GITLAB_TOKEN",
  "PRAXIS_GITLAB_BASE_URL",
  "PRAXIS_GITHUB_API_URL",
  "PRAXIS_GITHUB_TOKEN",
  "PRAXIS_SKIP_DOTENV",
  "PRAXIS_QUALITY_URL",
  "UNRELATED_TEMPLATE",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.PRAXIS_QUALITY_URL = "http://127.0.0.1:1/health";
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tmpRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "praxis-placeholder-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

describe("scrubUnexpandedPlaceholders", () => {
  it("removes whole-value PRAXIS_ placeholders and returns key names only", () => {
    const env: NodeJS.ProcessEnv = {
      PRAXIS_GITLAB_TOKEN: "${user_config.gitlab_token}",
      PRAXIS_GITHUB_API_URL: "  ${user_config.github_api_url} ",
      PRAXIS_JIRA_BASE_URL: "https://example.atlassian.net",
      PRAXIS_NOTE: "prefix-${user_config.x}",
      PRAXIS_TRAILING: "${a}b",
      UNRELATED_TEMPLATE: "${user_config.other}",
    };
    const removed = scrubUnexpandedPlaceholders(env);
    expect(removed.sort()).toEqual(["PRAXIS_GITHUB_API_URL", "PRAXIS_GITLAB_TOKEN"]);
    expect(removed.join(" ")).not.toContain("user_config");
    expect(env.PRAXIS_JIRA_BASE_URL).toBe("https://example.atlassian.net");
    expect(env.PRAXIS_NOTE).toBe("prefix-${user_config.x}");
    expect(env.PRAXIS_TRAILING).toBe("${a}b");
    expect(env.UNRELATED_TEMPLATE).toBe("${user_config.other}");
  });
});

describe("doctor with Claude Desktop placeholders", () => {
  it("reports blank optional GitLab/GitHub settings as unset", async () => {
    process.env.PRAXIS_GITLAB_TOKEN = "${user_config.gitlab_token}";
    process.env.PRAXIS_GITLAB_BASE_URL = "${user_config.gitlab_base_url}";
    process.env.PRAXIS_GITHUB_API_URL = "${user_config.github_api_url}";
    process.env.UNRELATED_TEMPLATE = "${user_config.other}";
    const out = (await doctorOp({ repo: tmpRepo() } as never, "test")) as Record<string, any>;
    expect(out.gitlab).toEqual({ tokenConfigured: false, baseUrlConfigured: false });
    expect(out.github.apiUrlConfigured).toBe(false);
    expect(out.github.apiUrlValid).toBe(true);
    expect(out.codes.github).toBeUndefined();
    expect(out.hostPlaceholdersIgnored).toEqual(
      expect.arrayContaining(["PRAXIS_GITHUB_API_URL", "PRAXIS_GITLAB_BASE_URL", "PRAXIS_GITLAB_TOKEN"]),
    );
    expect(JSON.stringify(out)).not.toContain("${user_config");
    expect(process.env.UNRELATED_TEMPLATE).toBe("${user_config.other}");
  });

  // Deliberate change after the alpha.48 behaviour (security review): a repository file can fill a blank host setting only for
  // allowlisted per-project naming settings. A URL or a credential from a file the agent can write could redirect a request
  // that carries the operator's real token, so those come only from the extension settings or the shell.
  it("lets a repository .env value replace a host placeholder for an allowlisted setting", () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, ".env.praxis"), "PRAXIS_JIRA_PROJECT_KEY=PRX\n");
    process.env.PRAXIS_JIRA_PROJECT_KEY = "${user_config.jira_project_key}";
    loadPraxisDotenv(repo);
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBe("PRX");
  });

  it("does not let a repository .env fill a blank host setting that carries a URL or a credential", () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, ".env.praxis"), "PRAXIS_GITLAB_BASE_URL=https://evil.example.test\nPRAXIS_JIRA_BASE_URL=https://evil.example.test\n");
    process.env.PRAXIS_GITLAB_BASE_URL = "${user_config.gitlab_base_url}";
    const operatorJira = process.env.PRAXIS_JIRA_BASE_URL;
    loadPraxisDotenv(repo);
    expect(process.env.PRAXIS_GITLAB_BASE_URL).toBeUndefined(); // the placeholder is scrubbed, the file value is refused
    expect(process.env.PRAXIS_JIRA_BASE_URL).toBe(operatorJira); // never the file's value
  });

  it("scrubs placeholders even when dotenv loading is disabled", () => {
    process.env.PRAXIS_SKIP_DOTENV = "1";
    process.env.PRAXIS_GITHUB_TOKEN = "${user_config.github_token}";
    loadPraxisDotenv(tmpRepo());
    expect(process.env.PRAXIS_GITHUB_TOKEN).toBeUndefined();
  });
});

// REQ-CFG-001 coverage: one test per acceptance criterion, plus the approval setting.
describe("REQ-CFG-001 acceptance criteria", () => {
  const DESKTOP_SETTINGS: Record<string, string> = {
    PRAXIS_JIRA_BASE_URL: "${user_config.jira_base_url}",
    PRAXIS_JIRA_EMAIL: "${user_config.jira_email}",
    PRAXIS_JIRA_PROJECT_KEY: "${user_config.jira_project_key}",
    PRAXIS_JIRA_TOKEN: "${user_config.jira_token}",
    PRAXIS_GITHUB_TOKEN: "${user_config.github_token}",
    PRAXIS_GITHUB_API_URL: "${user_config.github_api_url}",
    PRAXIS_GITLAB_TOKEN: "${user_config.gitlab_token}",
    PRAXIS_GITLAB_BASE_URL: "${user_config.gitlab_base_url}",
  };

  it("AC-01/02: every Desktop setting left blank is unset, in the doctor and in the approval report", async () => {
    const saved = Object.fromEntries(Object.keys(DESKTOP_SETTINGS).map((k) => [k, process.env[k]]));
    Object.assign(process.env, DESKTOP_SETTINGS);
    try {
      const out = (await doctorOp({ repo: tmpRepo() } as never, "test")) as Record<string, any>;
      expect(out.gitlab).toEqual({ tokenConfigured: false, baseUrlConfigured: false });
      expect(out.github.tokenConfigured).toBe(false);
      expect(out.github.apiUrlConfigured).toBe(false);
      expect(out.jira.configured).toBe(false);
      expect(out.approval.mode).toBe("no-dialog");
      expect(out.hostPlaceholdersIgnored).toEqual(expect.arrayContaining(Object.keys(DESKTOP_SETTINGS).filter((k) => k !== "PRAXIS_JIRA_TOKEN")));
      expect(JSON.stringify(out)).not.toContain("${");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("AC-03: a real value in .env (not only .env.praxis) replaces the placeholder, for allowlisted settings; a credential never comes from a repository file", () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, ".env"), "PRAXIS_JIRA_PROJECT_KEY=ABC\nPRAXIS_GITLAB_TOKEN=glpat-real-value-for-test\n");
    process.env.PRAXIS_JIRA_PROJECT_KEY = "${user_config.jira_project_key}";
    process.env.PRAXIS_GITLAB_TOKEN = "${user_config.gitlab_token}";
    loadPraxisDotenv(repo);
    expect(process.env.PRAXIS_JIRA_PROJECT_KEY).toBe("ABC");
    expect(process.env.PRAXIS_GITLAB_TOKEN).toBeUndefined();
  });

  it("AC-04: values that only contain a placeholder shape are left alone", () => {
    const env: NodeJS.ProcessEnv = {
      PRAXIS_A: "pa${ss}word",
      PRAXIS_B: "${a}${b}",
      PRAXIS_C: "${unterminated",
      PRAXIS_D: "$ {user_config.x}",
      PRAXIS_E: "https://example.test/${path}/x",
      PRAXIS_F: "",
    };
    const before = { ...env };
    expect(scrubUnexpandedPlaceholders(env)).toEqual([]);
    expect(env).toEqual(before);
  });

  it("AC-05: variables outside PRAXIS_ are never touched, even when they look like placeholders", () => {
    const env: NodeJS.ProcessEnv = { HOME: "${user_config.home}", PRAXIS: "${x}", NODE_OPTIONS: "${y}", praxis_lower: "${z}" };
    const removed = scrubUnexpandedPlaceholders(env);
    expect(removed).toEqual([]);
    expect(env.HOME).toBe("${user_config.home}");
    expect(env.NODE_OPTIONS).toBe("${y}");
    expect(env.praxis_lower).toBe("${z}");
  });

  it("AC-06: a real secret next to placeholders is never reported, logged or returned by the doctor", async () => {
    const secret = "ghp_REALSECRETVALUE0123456789abcdef";
    process.env.PRAXIS_GITHUB_TOKEN = secret;
    process.env.PRAXIS_GITLAB_TOKEN = "${user_config.gitlab_token}";
    const spy: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void spy.push(args.join(" "));
    try {
      const out = await doctorOp({ repo: tmpRepo() } as never, "test");
      expect(JSON.stringify(out)).not.toContain(secret);
      expect(spy.join("\n")).not.toContain(secret);
      expect(scrubUnexpandedPlaceholders({ PRAXIS_X: "${user_config.secret_name}" })).toEqual(["PRAXIS_X"]);
    } finally {
      console.error = original;
    }
  });
});
