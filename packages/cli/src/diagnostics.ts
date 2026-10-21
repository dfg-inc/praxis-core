/**
 * Pure diagnostics for praxis_doctor: which providers are usable, how approvals are
 * obtained, and what the operator should do next. No I/O, no secret values: only flags and key names.
 */

export type ProviderState = "unconfigured" | "partial" | "configured" | "invalid";

export type ProviderReport = {
  state: ProviderState;
  /** A provider that is not configured is fine unless the operator wants to use it. */
  required: false;
  /** Settings that are needed to use the provider and are absent. */
  missing: string[];
  /** Settings that are present but unusable, with the reason. */
  invalid: Array<{ setting: string; issue: string }>;
};

/** How the user's approval is obtained for protected actions in this session. */
export type ApprovalReport = {
  /** client-ui: asked in the MCP client's own dialog. no-dialog: the client cannot ask, so protected actions are not executed. */
  mode: "client-ui" | "no-dialog";
  /** Stated plainly, including what does not work. */
  note: string;
  /** Where decisions are journaled (outside the repository). */
  decisionLog: string;
};

import { approvalModeReport, decisionLogPath } from "@praxis/contracts";

const present = (value: string | undefined): boolean => Boolean(value && value.trim());

export function checkHttpUrl(raw: string | undefined): { ok: true } | { ok: false; issue: string } {
  const value = (raw ?? "").trim();
  if (!value) return { ok: true };
  if (/^git@/i.test(value) || /^ssh:\/\//i.test(value)) return { ok: false, issue: "git-ssh-remote" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, issue: "not-a-url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, issue: "unsupported-scheme" };
  if (url.username || url.password) return { ok: false, issue: "embedded-credentials" };
  return { ok: true };
}

function state(missing: string[], invalid: unknown[], anySet: boolean): ProviderState {
  if (invalid.length > 0) return "invalid";
  if (!anySet) return "unconfigured";
  return missing.length > 0 ? "partial" : "configured";
}

export function providerDiagnostics(
  env: NodeJS.ProcessEnv,
  githubApiUrl: { configured: boolean; valid: boolean; issue?: string },
): { jira: ProviderReport; github: ProviderReport; gitlab: ProviderReport } {
  const jiraFields: Array<[string, string | undefined]> = [
    ["jira_base_url", env.PRAXIS_JIRA_BASE_URL],
    ["jira_email", env.PRAXIS_JIRA_EMAIL],
    ["jira_project_key", env.PRAXIS_JIRA_PROJECT_KEY],
    ["jira_token", env.PRAXIS_JIRA_TOKEN],
  ];
  const jiraMissing = jiraFields.filter(([, value]) => !present(value)).map(([key]) => key);
  const jiraInvalid: ProviderReport["invalid"] = [];
  const jiraUrl = checkHttpUrl(env.PRAXIS_JIRA_BASE_URL);
  if (!jiraUrl.ok) jiraInvalid.push({ setting: "jira_base_url", issue: jiraUrl.issue });
  const jira: ProviderReport = {
    state: state(jiraMissing, jiraInvalid, jiraFields.some(([, value]) => present(value))),
    required: false,
    missing: jiraMissing.length === jiraFields.length ? [] : jiraMissing,
    invalid: jiraInvalid,
  };

  const githubMissing: string[] = [];
  const githubInvalid: ProviderReport["invalid"] = [];
  if (!githubApiUrl.valid) githubInvalid.push({ setting: "github_api_url", issue: githubApiUrl.issue ?? "invalid" });
  const githubToken = present(env.PRAXIS_GITHUB_TOKEN);
  if (githubApiUrl.configured && !githubToken) githubMissing.push("github_token");
  const github: ProviderReport = {
    state: state(githubMissing, githubInvalid, githubToken || githubApiUrl.configured),
    required: false,
    missing: githubMissing,
    invalid: githubInvalid,
  };

  const gitlabMissing: string[] = [];
  const gitlabInvalid: ProviderReport["invalid"] = [];
  const gitlabUrl = checkHttpUrl(env.PRAXIS_GITLAB_BASE_URL);
  if (!gitlabUrl.ok) gitlabInvalid.push({ setting: "gitlab_base_url", issue: gitlabUrl.issue });
  const gitlabToken = present(env.PRAXIS_GITLAB_TOKEN);
  if (present(env.PRAXIS_GITLAB_BASE_URL) && !gitlabToken) gitlabMissing.push("gitlab_token");
  const gitlab: ProviderReport = {
    state: state(gitlabMissing, gitlabInvalid, gitlabToken || present(env.PRAXIS_GITLAB_BASE_URL)),
    required: false,
    missing: gitlabMissing,
    invalid: gitlabInvalid,
  };
  return { jira, github, gitlab };
}

export function approvalDiagnostics(_env: NodeJS.ProcessEnv, repo?: string): ApprovalReport {
  const report = approvalModeReport();
  return { mode: report.mode, note: report.note, decisionLog: repo ? decisionLogPath(repo) : "~/.praxis/decisions/<repository id>.jsonl" };
}

export function doctorNextSteps(input: {
  repoExists: boolean;
  gitRoot: boolean;
  project: "loaded" | "missing" | "invalid";
  quality: { status: string; logPath?: string };
  providers: { jira: ProviderReport; github: ProviderReport; gitlab: ProviderReport };
  approval: ApprovalReport;
  dotenvRejected?: string[];
}): string[] {
  const steps: string[] = [];
  if (!input.repoExists) {
    steps.push("The repository path does not exist. Pass repo=<path to a checked-out product repository>.");
    return steps;
  }
  if (!input.gitRoot) steps.push("The path is not inside a git repository. Run `git init` or pass the repository root.");
  if (input.project === "missing") {
    steps.push(
      "No .project file. Run praxis_project_init_preview, review the inferred YAML, then praxis_project_init_apply with confirmation=YES.",
    );
  } else if (input.project === "invalid") {
    steps.push("The .project file is invalid. Fix it, or review praxis_project_init_preview and re-apply.");
  }
  switch (input.quality.status) {
    case "healthy":
      break;
    case "not_started":
    case "stopped":
      steps.push("The Quality service is not running (this is normal until first use). Run praxis_quality_ensure to start it.");
      break;
    case "starting":
      steps.push("The Quality service is starting. Call praxis_quality_status again in a few seconds.");
      break;
    default:
      steps.push(
        `The Quality service is ${input.quality.status}. Run praxis_quality_ensure; if it fails, read ${input.quality.logPath ?? ".praxis-quality/quality.log"}.`,
      );
  }
  for (const [name, report] of Object.entries(input.providers)) {
    for (const item of report.invalid) {
      steps.push(`${name}: ${item.setting} is invalid (${item.issue}). Correct it in the extension settings or leave it blank.`);
    }
    if (report.state === "partial") {
      steps.push(`${name}: partially configured; missing ${report.missing.join(", ")}. Complete it or clear the other ${name} settings.`);
    }
  }
  if (input.approval.mode === "no-dialog") {
    steps.push(
      "This MCP client cannot show an approval dialog (no elicitation support). Read-only tools and previews work, but protected actions (Git, Jira, confirming a Story or decision, Quality fixes) are NOT executed: nothing the agent says counts as your approval. Use a client that supports approval dialogs to apply them. Some hosts (Claude Desktop) have their own tool-permission prompt instead of a dialog: praxis_doctor approval.client shows what yours declared, and the optional host-permission setting (docs/user-approval.md) uses that prompt with the exact plan in the tool arguments; it is weaker, because Praxis cannot see whether the prompt was shown.",
    );
  }
  if (input.dotenvRejected?.length) {
    steps.push(
      `A repository .env file tried to set ${input.dotenvRejected.join(", ")}. Approval settings are only read from the real environment, so they were ignored. Remove them from the file.`,
    );
  }
  return steps;
}
