/**
 * Pure diagnostics for praxis_doctor: which providers are usable, what security mode is in
 * force, and what the operator should do next. No I/O, no secret values: only flags and key names.
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

export type SecurityReport = {
  mode: "secure" | "compatibility" | "invalid";
  /** What the mode means for mutations, stated plainly. */
  approvals: string;
  /** True only when no evidence visible from this process says the agent can reach the trust chain. */
  secureOperation: boolean;
  /** isolated | unisolated | unconfigured | compatibility | invalid. Evidence-based, never a configuration claim. */
  deploymentTier: string;
  /** Why secure operation is or is not available. Names settings and reasons, never values. */
  deployment: Array<{ id: string; severity: "blocking" | "warning"; detail: string; remedy: string }>;
};

import { assessApprovalDeployment } from "@praxis/contracts";

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

export function securityDiagnostics(env: NodeJS.ProcessEnv, workspace?: string): SecurityReport {
  const raw = (env.PRAXIS_SECURITY_MODE ?? "").trim();
  const assessment = assessApprovalDeployment({ env, workspace });
  const evidence = {
    secureOperation: assessment.secureOperation,
    deploymentTier: assessment.tier,
    deployment: assessment.findings,
  };
  if (raw === "" || raw === "secure") {
    return {
      mode: "secure",
      approvals:
        "Protected mutations need an approval signed by a broker the agent cannot reach; confirmation=YES alone and local approval files are refused. Agent-authored workflow records are written without one and are marked as unconfirmed.",
      ...evidence,
    };
  }
  if (raw === "compatibility") {
    return {
      mode: "compatibility",
      approvals:
        "Approvals are NOT enforced against the agent: stored approval files are forgeable by the same user. This is not a security boundary.",
      ...evidence,
    };
  }
  return {
    mode: "invalid",
    approvals: "PRAXIS_SECURITY_MODE must be 'secure' or 'compatibility'; mutations fail closed until it is fixed.",
    ...evidence,
  };
}

export function doctorNextSteps(input: {
  repoExists: boolean;
  gitRoot: boolean;
  project: "loaded" | "missing" | "invalid";
  quality: { status: string; logPath?: string };
  providers: { jira: ProviderReport; github: ProviderReport; gitlab: ProviderReport };
  security: SecurityReport;
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
  if (input.security.mode === "secure" && !input.security.secureOperation) {
    const blocking = input.security.deployment.filter((finding) => finding.severity === "blocking");
    steps.push(
      `Secure operation is NOT available on this host (${input.security.deploymentTier}): protected mutations (Jira, Git, confirmations) are refused until an isolated broker is in place. ` +
        blocking.map((finding) => `${finding.id}: ${finding.remedy}`).join(" "),
    );
  }
  if (input.security.mode === "invalid") {
    steps.push("Set PRAXIS_SECURITY_MODE (extension setting security_mode) to 'secure' or 'compatibility', or leave it blank for secure.");
  } else if (input.security.mode === "compatibility") {
    steps.push("Compatibility mode is on: approvals are not enforced. Use it only for local development you fully trust.");
  }
  if (input.dotenvRejected?.length) {
    steps.push(
      `A repository .env file tried to set ${input.dotenvRejected.join(", ")}. Security and approval settings are only read from the real environment, so they were ignored. Remove them from the file.`,
    );
  }
  return steps;
}
