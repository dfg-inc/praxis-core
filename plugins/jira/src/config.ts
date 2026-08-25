export type JiraConfig = {
  baseUrl: string;
  token: string;
  projectKey: string;
  /** Optional custom field id for architect estimate (Server). */
  architectEstimateFieldId?: string;
};

export function loadJiraConfig(
  env: NodeJS.ProcessEnv = process.env,
): JiraConfig {
  const baseUrl = (env.PRAXIS_JIRA_BASE_URL ?? "").replace(/\/$/, "");
  const token = env.PRAXIS_JIRA_TOKEN ?? "";
  const projectKey = env.PRAXIS_JIRA_PROJECT_KEY ?? "";
  if (!baseUrl || !token || !projectKey) {
    throw new Error(
      "Missing PRAXIS_JIRA_BASE_URL, PRAXIS_JIRA_TOKEN, or PRAXIS_JIRA_PROJECT_KEY",
    );
  }
  return {
    baseUrl,
    token,
    projectKey,
    architectEstimateFieldId: env.PRAXIS_JIRA_ARCHITECT_ESTIMATE_FIELD,
  };
}
