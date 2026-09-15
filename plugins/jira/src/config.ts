export type JiraMode = "cloud" | "datacenter" | "auto";

export type JiraAuthMode = "pat" | "cloud-basic" | "oauth-placeholder";

export type JiraConfig = {
  mode: "cloud" | "datacenter";
  baseUrl: string;
  token: string;
  projectKey: string;
  email?: string;
  cloudId?: string;
  authMode: JiraAuthMode;
  architectEstimateFieldId?: string;
  epicType: string;
  storyType: string;
  taskType: string;
  bugType: string;
  workPackageType: string;
  epicTypeId?: string;
  storyTypeId?: string;
  taskTypeId?: string;
  bugTypeId?: string;
  storyPointsField?: string;
  transitions: Record<string, string>;
  workPackageMaxHours: number;
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

function readTransitions(env: NodeJS.ProcessEnv): Record<string, string> {
  const keys = [
    "IN_PROGRESS",
    "READY_FOR_ARCH",
    "READY_FOR_DEV",
    "READY_FOR_QA",
    "DONE",
    "BLOCKED",
  ] as const;
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = env[`PRAXIS_JIRA_TRANSITION_${k}`];
    if (v) out[k.toLowerCase().replace(/_/g, "-")] = v;
  }
  return out;
}

export function detectJiraMode(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
): "cloud" | "datacenter" {
  const raw = (env.PRAXIS_JIRA_MODE ?? "").trim().toLowerCase();
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return "";
    }
  })();
  const looksCloud = host.endsWith(".atlassian.net");

  if (raw === "cloud") return "cloud";
  if (raw === "datacenter" || raw === "server") return "datacenter";
  if (raw === "auto") {
    if (looksCloud) return "cloud";
    if (host) return "datacenter";
    throw new Error(
      "PRAXIS_JIRA_MODE=auto could not detect Cloud vs Data Center. Set PRAXIS_JIRA_MODE=cloud or datacenter explicitly.",
    );
  }
  if (raw && raw !== "") {
    throw new Error(
      `Unknown PRAXIS_JIRA_MODE=${raw}. Use cloud, datacenter, or auto.`,
    );
  }
  return looksCloud ? "cloud" : "datacenter";
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

  const mode = detectJiraMode(env, baseUrl);
  const email = env.PRAXIS_JIRA_EMAIL ?? "";
  if (mode === "cloud" && !email) {
    throw new Error(
      "PRAXIS_JIRA_EMAIL is required for Cloud (email + API token). OAuth 2.0/3LO is reserved (PRAXIS_JIRA_AUTH=oauth is not implemented).",
    );
  }
  if (env.PRAXIS_JIRA_AUTH === "oauth") {
    throw new Error(
      "PRAXIS_JIRA_AUTH=oauth is a reserved provider hook (OAuth 2.0/3LO) and is not implemented yet.",
    );
  }

  const maxHours = Number(env.PRAXIS_WORK_PACKAGE_MAX_HOURS ?? "16");
  return {
    mode,
    baseUrl,
    token,
    projectKey,
    email: email || undefined,
    cloudId: env.PRAXIS_JIRA_CLOUD_ID,
    authMode: mode === "cloud" ? "cloud-basic" : "pat",
    architectEstimateFieldId: env.PRAXIS_JIRA_ARCHITECT_ESTIMATE_FIELD,
    epicType: env.PRAXIS_JIRA_EPIC_TYPE ?? "Epic",
    storyType: env.PRAXIS_JIRA_STORY_TYPE ?? "Story",
    taskType: env.PRAXIS_JIRA_TASK_TYPE ?? "Task",
    bugType: env.PRAXIS_JIRA_BUG_TYPE ?? "Bug",
    workPackageType: env.PRAXIS_JIRA_WORK_PACKAGE_TYPE ?? "",
    epicTypeId: env.PRAXIS_JIRA_EPIC_TYPE_ID || undefined,
    storyTypeId: env.PRAXIS_JIRA_STORY_TYPE_ID || undefined,
    taskTypeId: env.PRAXIS_JIRA_TASK_TYPE_ID || undefined,
    bugTypeId: env.PRAXIS_JIRA_BUG_TYPE_ID || undefined,
    storyPointsField: env.PRAXIS_JIRA_STORY_POINTS_FIELD,
    transitions: readTransitions(env),
    workPackageMaxHours: Number.isFinite(maxHours) ? maxHours : 16,
  };
}
