import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHttpUrl, doctorNextSteps, providerDiagnostics, securityDiagnostics } from "./diagnostics.js";
import { doctorOp } from "./operations.js";

const ok = { configured: false, valid: true };

describe("providerDiagnostics", () => {
  it("an empty environment is unconfigured, not an error, and Jira is not required", () => {
    const { jira, github, gitlab } = providerDiagnostics({}, ok);
    for (const report of [jira, github, gitlab]) {
      expect(report).toEqual({ state: "unconfigured", required: false, missing: [], invalid: [] });
    }
  });

  it("separates missing from invalid for Jira", () => {
    const partial = providerDiagnostics({ PRAXIS_JIRA_BASE_URL: "https://x.atlassian.net" }, ok).jira;
    expect(partial.state).toBe("partial");
    expect(partial.missing).toEqual(["jira_email", "jira_project_key", "jira_token"]);
    expect(partial.invalid).toEqual([]);
    const invalid = providerDiagnostics(
      { PRAXIS_JIRA_BASE_URL: "not a url", PRAXIS_JIRA_EMAIL: "a@b.c", PRAXIS_JIRA_PROJECT_KEY: "P", PRAXIS_JIRA_TOKEN: "t" },
      ok,
    ).jira;
    expect(invalid.state).toBe("invalid");
    expect(invalid.invalid).toEqual([{ setting: "jira_base_url", issue: "not-a-url" }]);
    const full = providerDiagnostics(
      { PRAXIS_JIRA_BASE_URL: "https://x.atlassian.net", PRAXIS_JIRA_EMAIL: "a@b.c", PRAXIS_JIRA_PROJECT_KEY: "P", PRAXIS_JIRA_TOKEN: "t" },
      ok,
    ).jira;
    expect(full.state).toBe("configured");
  });

  it("reports GitHub and GitLab precisely", () => {
    expect(providerDiagnostics({ PRAXIS_GITHUB_TOKEN: "t" }, ok).github.state).toBe("configured");
    const bad = providerDiagnostics({}, { configured: true, valid: false, issue: "git-ssh-remote" }).github;
    expect(bad.state).toBe("invalid");
    expect(bad.invalid).toEqual([{ setting: "github_api_url", issue: "git-ssh-remote" }]);
    expect(providerDiagnostics({ PRAXIS_GITLAB_BASE_URL: "https://gl.example" }, ok).gitlab).toMatchObject({
      state: "partial",
      missing: ["gitlab_token"],
    });
    expect(providerDiagnostics({ PRAXIS_GITLAB_TOKEN: "t" }, ok).gitlab.state).toBe("configured");
    expect(providerDiagnostics({ PRAXIS_GITLAB_TOKEN: "t", PRAXIS_GITLAB_BASE_URL: "ftp://x" }, ok).gitlab.state).toBe("invalid");
  });

  it("never echoes setting values", () => {
    const out = JSON.stringify(
      providerDiagnostics({ PRAXIS_JIRA_TOKEN: "SECRET-TOKEN", PRAXIS_JIRA_BASE_URL: "https://u:pw@x.test" }, ok),
    );
    expect(out).not.toContain("SECRET-TOKEN");
    expect(out).not.toContain("pw@");
  });
});

describe("checkHttpUrl", () => {
  it.each([
    ["", true],
    ["https://a.example", true],
    ["http://localhost:8080", true],
    ["git@github.com:o/r.git", false],
    ["ssh://git@x/y", false],
    ["ftp://x", false],
    ["https://user:pass@x", false],
    ["nonsense", false],
  ])("%s -> %s", (value, expected) => expect(checkHttpUrl(value).ok).toBe(expected));
});

describe("securityDiagnostics", () => {
  it("blank and secure mean secure; compatibility is labelled unenforced; junk fails closed", () => {
    expect(securityDiagnostics({}).mode).toBe("secure");
    expect(securityDiagnostics({ PRAXIS_SECURITY_MODE: "secure" }).mode).toBe("secure");
    const compat = securityDiagnostics({ PRAXIS_SECURITY_MODE: "compatibility" });
    expect(compat.mode).toBe("compatibility");
    expect(compat.approvals).toMatch(/NOT enforced/);
    expect(securityDiagnostics({ PRAXIS_SECURITY_MODE: "off" }).mode).toBe("invalid");
    expect(securityDiagnostics({}).isolation).toBe("unverified");
  });
});

describe("doctorNextSteps", () => {
  const base = {
    repoExists: true,
    gitRoot: true,
    project: "loaded" as const,
    quality: { status: "healthy" },
    providers: providerDiagnostics({}, ok),
    security: securityDiagnostics({}),
  };

  it("has nothing to say when everything is in order (Jira is optional)", () => {
    expect(doctorNextSteps(base)).toEqual([]);
  });

  it("gives actionable steps for a missing .project and a not-started Quality service", () => {
    const steps = doctorNextSteps({ ...base, project: "missing", quality: { status: "not_started" } });
    expect(steps.join("\n")).toMatch(/praxis_project_init_preview.*praxis_project_init_apply/);
    expect(steps.join("\n")).toMatch(/praxis_quality_ensure/);
    expect(steps.join("\n")).toMatch(/normal until first use/);
  });

  it("points at the log for a failed Quality service and explains partial and invalid providers", () => {
    const steps = doctorNextSteps({
      ...base,
      quality: { status: "failed", logPath: "/x/quality.log" },
      providers: providerDiagnostics({ PRAXIS_GITLAB_BASE_URL: "https://gl.example", PRAXIS_JIRA_BASE_URL: "bad" }, ok),
    }).join("\n");
    expect(steps).toMatch(/failed.*\/x\/quality\.log/);
    expect(steps).toMatch(/gitlab: partially configured; missing gitlab_token/);
    expect(steps).toMatch(/jira: jira_base_url is invalid \(not-a-url\)/);
  });

  it("warns about compatibility mode and refused dotenv keys", () => {
    const steps = doctorNextSteps({
      ...base,
      security: securityDiagnostics({ PRAXIS_SECURITY_MODE: "compatibility" }),
      dotenvRejected: ["PRAXIS_SECURITY_MODE"],
    }).join("\n");
    expect(steps).toMatch(/Compatibility mode is on/);
    expect(steps).toMatch(/PRAXIS_SECURITY_MODE.*ignored/);
  });

  it("a missing repository short-circuits", () => {
    expect(doctorNextSteps({ ...base, repoExists: false })).toHaveLength(1);
  });
});

describe("doctor end to end", () => {
  // The runner may inherit the operator's real PRAXIS_* settings; start every case from a clean slate.
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PRAXIS_")));
    for (const k of Object.keys(saved)) delete process.env[k];
    process.env.PRAXIS_QUALITY_URL = "http://127.0.0.1:1/health";
  });
  afterEach(() => {
    for (const k of Object.keys(process.env).filter((key) => key.startsWith("PRAXIS_"))) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  });

  it("a fresh repository with no settings reports actionable steps and no provider errors", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-doctor-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    const out = (await doctorOp({ repo } as never, "test")) as Record<string, any>;
    expect(out.providers.jira.state).toBe("unconfigured");
    expect(out.providers.jira.required).toBe(false);
    expect(out.security.mode).toBe("secure");
    expect(out.project.status).toBe("missing");
    expect(out.nextSteps.join("\n")).toMatch(/praxis_project_init_preview/);
    expect(out.nextSteps.join("\n")).toMatch(/praxis_quality_ensure/);
    expect(out.nextSteps.join("\n")).not.toMatch(/jira/i);
  });

  it("Desktop placeholders for every optional setting leave all providers unconfigured", async () => {
    process.env.PRAXIS_JIRA_BASE_URL = "${user_config.jira_base_url}";
    process.env.PRAXIS_GITLAB_TOKEN = "${user_config.gitlab_token}";
    process.env.PRAXIS_SECURITY_MODE = "${user_config.security_mode}";
    const repo = mkdtempSync(join(tmpdir(), "praxis-doctor-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    const out = (await doctorOp({ repo } as never, "test")) as Record<string, any>;
    expect(out.providers.jira.state).toBe("unconfigured");
    expect(out.providers.gitlab.state).toBe("unconfigured");
    expect(out.security.mode).toBe("secure");
    expect(out.hostPlaceholdersIgnored).toEqual(
      expect.arrayContaining(["PRAXIS_JIRA_BASE_URL", "PRAXIS_GITLAB_TOKEN", "PRAXIS_SECURITY_MODE"]),
    );
  });
});
