import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalDiagnostics, checkHttpUrl, doctorNextSteps, providerDiagnostics, type ApprovalReport } from "./diagnostics.js";
import { withApprovalChannel } from "@praxis/contracts";
import { doctorOp } from "./operations.js";
import { writeFileSync } from "node:fs";

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

describe("approvalDiagnostics", () => {
  it("a client that cannot show a dialog is reported plainly: protected actions are not executed", () => {
    const report = approvalDiagnostics({});
    expect(report.mode).toBe("no-dialog");
    expect(report.note).toMatch(/NOT executed/);
    expect(report.decisionLog).toMatch(/decisions/);
  });

  it("a client that can ask is reported as client-ui; the journal is outside the repository", () => {
    const channel = { kind: "client-elicitation" as const, ask: async () => ({ answer: "approve" as const }) };
    const repo = mkdtempSync(join(tmpdir(), "praxis-diag-"));
    const report = withApprovalChannel(channel, () => approvalDiagnostics({}, repo));
    expect(report.mode).toBe("client-ui");
    expect(report.decisionLog.startsWith(repo)).toBe(false);
  });
});

describe("doctorNextSteps", () => {
  const base = {
    repoExists: true,
    gitRoot: true,
    project: "loaded" as const,
    quality: { status: "healthy" },
    providers: providerDiagnostics({}, ok),
    approval: { mode: "client-ui", note: "", decisionLog: "" } as ApprovalReport,
  };

  it("has nothing to say when everything is in order (Jira is optional)", () => {
    expect(doctorNextSteps(base)).toEqual([]);
  });

  it("says plainly that protected actions are not executed when the client cannot show an approval dialog", () => {
    const steps = doctorNextSteps({ ...base, approval: approvalDiagnostics({}) }).join("\n");
    expect(steps).toMatch(/cannot show an approval dialog/);
    expect(steps).toMatch(/NOT executed/);
    expect(steps).toMatch(/nothing the agent says counts as your approval/);
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

  it("names the refused dotenv keys and says they were ignored", () => {
    const steps = doctorNextSteps({ ...base, dotenvRejected: ["PRAXIS_TEST_APPROVALS"] }).join("\n");
    expect(steps).toMatch(/PRAXIS_TEST_APPROVALS.*ignored/);
  });

  it("groups refused repository .env keys: operator environment, never allowed, malformed value", () => {
    const steps = doctorNextSteps({
      ...base,
      dotenvRefused: [
        { key: "PRAXIS_JIRA_TOKEN", reason: "not-allowed" },
        { key: "PRAXIS_APPROVAL_MODE", reason: "trust" },
        { key: "PRAXIS_JIRA_PROJECT_KEY", reason: "bad-value-shape" },
      ],
    }).join("\n");
    expect(steps).toMatch(/Ignored, move to the operator environment:.*PRAXIS_JIRA_TOKEN/);
    expect(steps).toMatch(/extension settings.*shell.*claude mcp add -e KEY=/);
    expect(steps).toMatch(/Never allowed from a repository:.*PRAXIS_APPROVAL_MODE/);
    expect(steps).toMatch(/malformed value: PRAXIS_JIRA_PROJECT_KEY/);
    expect(steps).toMatch(/To migrate: copy.*delete them from the file.*restart.*praxis_doctor again/);
  });

  it("a malformed value alone gets no migration step", () => {
    const steps = doctorNextSteps({ ...base, dotenvRefused: [{ key: "PRAXIS_JIRA_PROJECT_KEY", reason: "bad-value-shape" }] }).join("\n");
    expect(steps).toMatch(/malformed value/);
    expect(steps).not.toMatch(/To migrate/);
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
    expect(out.approval.mode).toBe("no-dialog");
    expect(out.project.status).toBe("missing");
    expect(out.nextSteps.join("\n")).toMatch(/praxis_project_init_preview/);
    expect(out.nextSteps.join("\n")).toMatch(/praxis_quality_ensure/);
    // Jira is optional: no step is about Jira configuration.
    expect(out.nextSteps.filter((step: string) => /^jira:/i.test(step))).toEqual([]);
    expect(out.approval).toMatchObject({ mode: "no-dialog" });
    expect(out.security).toBeUndefined();
    expect(out.approvalService).toBeUndefined();
  });

  it("Desktop placeholders for every optional setting leave all providers unconfigured", async () => {
    process.env.PRAXIS_JIRA_BASE_URL = "${user_config.jira_base_url}";
    process.env.PRAXIS_GITLAB_TOKEN = "${user_config.gitlab_token}";
    const repo = mkdtempSync(join(tmpdir(), "praxis-doctor-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    const out = (await doctorOp({ repo } as never, "test")) as Record<string, any>;
    expect(out.providers.jira.state).toBe("unconfigured");
    expect(out.providers.gitlab.state).toBe("unconfigured");
    expect(out.hostPlaceholdersIgnored).toEqual(
      expect.arrayContaining(["PRAXIS_JIRA_BASE_URL", "PRAXIS_GITLAB_TOKEN"]),
    );
  });

  it("a repository .env with a token, a URL, an approval mode and a malformed project key: names grouped, no value anywhere", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-doctor-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(
      join(repo, ".env"),
      [
        "PRAXIS_JIRA_TOKEN=tok-SECRET-123",
        "PRAXIS_JIRA_BASE_URL=https://evil.example.test/SECRET-URL",
        "PRAXIS_APPROVAL_MODE=trusted-client",
        "PRAXIS_JIRA_PROJECT_KEY=bad/key?SECRET",
        "PRAXIS_JIRA_STORY_TYPE=Story",
        "PRAXIS_GIT_PROVIDER=github",
      ].join("\n"),
    );
    const out = (await doctorOp({ repo } as never, "test")) as Record<string, any>;
    expect(out.dotenvRefused).toEqual([
      { key: "PRAXIS_APPROVAL_MODE", reason: "trust" },
      { key: "PRAXIS_JIRA_BASE_URL", reason: "not-allowed" },
      { key: "PRAXIS_JIRA_PROJECT_KEY", reason: "bad-value-shape" },
      { key: "PRAXIS_JIRA_TOKEN", reason: "not-allowed" },
    ]);
    expect(out.dotenvLoaded).toEqual(["PRAXIS_GIT_PROVIDER", "PRAXIS_JIRA_STORY_TYPE"]);
    // alpha.48-compatible fields are still there
    expect(out.dotenvRejected).toEqual(expect.arrayContaining(["PRAXIS_JIRA_TOKEN", "PRAXIS_APPROVAL_MODE"]));
    expect(out.jira.tokenConfigured).toBe(false);
    const text = JSON.stringify(out);
    for (const secret of ["tok-SECRET-123", "SECRET-URL", "evil.example.test", "trusted-client", "bad/key"]) expect(text).not.toContain(secret);
    const steps = out.nextSteps.join("\n");
    expect(steps).toMatch(/Ignored, move to the operator environment: .*PRAXIS_JIRA_BASE_URL, PRAXIS_JIRA_TOKEN/);
    expect(steps).toMatch(/Never allowed from a repository: .*PRAXIS_APPROVAL_MODE/);
    expect(steps).toMatch(/malformed value: PRAXIS_JIRA_PROJECT_KEY/);
  });

  it("an empty repository .env refuses nothing", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-doctor-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".env"), "DATABASE_URL=postgres://x\nPRAXIS_JIRA_PROJECT_KEY=PRX\n");
    const out = (await doctorOp({ repo } as never, "test")) as Record<string, any>;
    expect(out.dotenvRefused).toEqual([]);
    expect(out.dotenvLoaded).toEqual(["PRAXIS_JIRA_PROJECT_KEY"]);
  });
});
