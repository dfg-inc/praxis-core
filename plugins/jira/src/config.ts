export type JiraConfig = {
  baseUrl: string;
  token: string;
  projectKey: string;
  /** Optional custom field id for architect estimate (Server). */
  architectEstimateFieldId?: string;
};

/** Jira Server 8.14+ supports personal access tokens. */
export const JIRA_PAT_MIN_VERSION = "8.14.0";

export function parseJiraVersion(raw: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const m = String(raw ?? "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) throw new Error(`unrecognized Jira version: ${raw}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] ?? 0),
  };
}

export function compareSemVerLike(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function patSupportedForVersion(version: string): {
  supported: boolean;
  version: string;
  guidance?: string;
} {
  const parsed = parseJiraVersion(version);
  const min = parseJiraVersion(JIRA_PAT_MIN_VERSION);
  if (compareSemVerLike(parsed, min) < 0) {
    return {
      supported: false,
      version,
      guidance:
        `Jira ${version} does not support personal access tokens (need ${JIRA_PAT_MIN_VERSION}+). ` +
        "Configure an application link with OAuth / incoming authentication signed by a consumer key instead of PRAXIS_JIRA_TOKEN PAT.",
    };
  }
  return { supported: true, version };
}

export function loadJiraConfig(
  env: NodeJS.ProcessEnv = process.env,
): JiraConfig {
  const baseUrl = (env.PRAXIS_JIRA_BASE_URL ?? "").replace(/\/$/, "");
  const token = env.PRAXIS_JIRA_TOKEN ?? "";
  const projectKey = env.PRAXIS_JIRA_PROJECT_KEY ?? "";
  const missing = [
    !baseUrl ? "PRAXIS_JIRA_BASE_URL" : null,
    !token ? "PRAXIS_JIRA_TOKEN" : null,
    !projectKey ? "PRAXIS_JIRA_PROJECT_KEY" : null,
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`malformed PRAXIS_JIRA_BASE_URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`PRAXIS_JIRA_BASE_URL must be http(s): ${baseUrl}`);
  }
  return {
    baseUrl,
    token,
    projectKey,
    architectEstimateFieldId: env.PRAXIS_JIRA_ARCHITECT_ESTIMATE_FIELD,
  };
}
