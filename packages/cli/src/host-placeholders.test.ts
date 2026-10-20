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

  it("lets a repository .env value replace a host placeholder", () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, ".env.praxis"), "PRAXIS_GITLAB_BASE_URL=https://gitlab.example.test\n");
    process.env.PRAXIS_GITLAB_BASE_URL = "${user_config.gitlab_base_url}";
    loadPraxisDotenv(repo);
    expect(process.env.PRAXIS_GITLAB_BASE_URL).toBe("https://gitlab.example.test");
  });

  it("scrubs placeholders even when dotenv loading is disabled", () => {
    process.env.PRAXIS_SKIP_DOTENV = "1";
    process.env.PRAXIS_GITHUB_TOKEN = "${user_config.github_token}";
    loadPraxisDotenv(tmpRepo());
    expect(process.env.PRAXIS_GITHUB_TOKEN).toBeUndefined();
  });
});
