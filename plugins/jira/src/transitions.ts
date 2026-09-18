export type SemanticTransition = "START_DEVELOPMENT" | "READY_FOR_QA";

export type TransitionInfo = {
  id: string;
  name: string;
  toStatus?: string;
  toStatusId?: string;
  toStatusCategory?: string;
};

export type JiraTransitionErrorCode =
  | "JIRA_TRANSITION_ID_INVALID"
  | "JIRA_TRANSITION_NOT_AVAILABLE"
  | "WORK_PACKAGE_ALREADY_CLAIMED";

export class JiraTransitionError extends Error {
  readonly code: JiraTransitionErrorCode;
  readonly issueKey?: string;
  readonly semanticAction?: string;
  readonly resolvedValue?: unknown;
  readonly currentStatus?: string;
  readonly available?: Array<{ id: string; name: string; toStatus?: string }>;
  constructor(
    code: JiraTransitionErrorCode,
    message: string,
    details?: {
      issueKey?: string;
      semanticAction?: string;
      resolvedValue?: unknown;
      currentStatus?: string;
      available?: Array<{ id: string; name: string; toStatus?: string }>;
    },
  ) {
    super(`${code}: ${message}`);
    this.name = "JiraTransitionError";
    this.code = code;
    this.issueKey = details?.issueKey;
    this.semanticAction = details?.semanticAction;
    this.resolvedValue = details?.resolvedValue;
    this.currentStatus = details?.currentStatus;
    this.available = details?.available;
  }
}

const TARGET_CATEGORY: Record<SemanticTransition, string> = {
  START_DEVELOPMENT: "indeterminate",
  READY_FOR_QA: "done",
};

const MAPPING_KEYS: Record<SemanticTransition, string[]> = {
  START_DEVELOPMENT: ["in-progress", "ready-for-dev"],
  READY_FOR_QA: ["ready-for-qa", "done"],
};

export function parseNumericTransitionId(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return String(raw);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return raw.trim();
  }
  return undefined;
}

export function assertNumericTransitionId(
  raw: unknown,
  details: { issueKey?: string; semanticAction?: string },
): string {
  const id = parseNumericTransitionId(raw);
  if (!id) {
    throw new JiraTransitionError(
      "JIRA_TRANSITION_ID_INVALID",
      `transition id must be an integer (got ${JSON.stringify(raw)})`,
      { ...details, resolvedValue: raw },
    );
  }
  return id;
}

export function normalizeTransitionText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function parseJiraTransitions(raw: unknown): TransitionInfo[] {
  const list = Array.isArray((raw as { transitions?: unknown })?.transitions)
    ? ((raw as { transitions: unknown[] }).transitions)
    : Array.isArray(raw)
      ? raw
      : [];
  const out: TransitionInfo[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const t = item as {
      id?: unknown;
      name?: unknown;
      to?: {
        id?: unknown;
        name?: unknown;
        statusCategory?: { key?: unknown; name?: unknown };
      };
    };
    const id = parseNumericTransitionId(t.id);
    if (!id) continue;
    out.push({
      id,
      name: typeof t.name === "string" ? t.name : "",
      toStatus: typeof t.to?.name === "string" ? t.to.name : undefined,
      toStatusId: parseNumericTransitionId(t.to?.id),
      toStatusCategory:
        typeof t.to?.statusCategory?.key === "string"
          ? t.to.statusCategory.key
          : undefined,
    });
  }
  return out;
}

export function summarizeTransitions(available: TransitionInfo[]) {
  return available.map((t) => ({
    id: t.id,
    name: t.name,
    toStatus: t.toStatus,
  }));
}

export function isSemanticStatusSatisfied(
  semantic: SemanticTransition,
  current: { status?: string; statusCategory?: string },
): boolean {
  return current.statusCategory === TARGET_CATEGORY[semantic];
}

export function resolveSemanticTransition(opts: {
  semantic: SemanticTransition;
  available: TransitionInfo[];
  mapping?: Record<string, string>;
  issueKey: string;
  currentStatus?: string;
  currentStatusCategory?: string;
}): { id: string; name: string; alreadySatisfied: boolean } {
  const available = opts.available;
  const summary = summarizeTransitions(available);
  if (
    isSemanticStatusSatisfied(opts.semantic, {
      status: opts.currentStatus,
      statusCategory: opts.currentStatusCategory,
    })
  ) {
    return { id: "", name: "", alreadySatisfied: true };
  }

  for (const key of MAPPING_KEYS[opts.semantic]) {
    const mapped = opts.mapping?.[key];
    if (!mapped) continue;
    const id = parseNumericTransitionId(mapped);
    if (!id) {
      throw new JiraTransitionError(
        "JIRA_TRANSITION_ID_INVALID",
        `configured mapping ${key} is not a numeric transition id`,
        {
          issueKey: opts.issueKey,
          semanticAction: opts.semantic,
          resolvedValue: mapped,
          currentStatus: opts.currentStatus,
          available: summary,
        },
      );
    }
    const hit = available.find((t) => t.id === id);
    if (hit) return { id: hit.id, name: hit.name, alreadySatisfied: false };
  }

  const category = TARGET_CATEGORY[opts.semantic];
  const byCategory = available.filter((t) => t.toStatusCategory === category);
  const chosen =
    byCategory.length === 1
      ? byCategory[0]
      : byCategory.length > 1
        ? [...byCategory].sort((a, b) => Number(a.id) - Number(b.id))[0]
        : undefined;
  if (chosen) {
    return { id: chosen.id, name: chosen.name, alreadySatisfied: false };
  }

  throw new JiraTransitionError(
    "JIRA_TRANSITION_NOT_AVAILABLE",
    `no available Jira transition for ${opts.semantic}`,
    {
      issueKey: opts.issueKey,
      semanticAction: opts.semantic,
      currentStatus: opts.currentStatus,
      available: summary,
    },
  );
}

export function transitionPostBody(id: string): { transition: { id: string } } {
  assertNumericTransitionId(id, {});
  return { transition: { id } };
}

export type TransitionPlanner = {
  config: { transitions: Record<string, string> };
  getIssue(key: string): Promise<{ status: string; statusCategory?: string }>;
  getTransitions(key: string): Promise<unknown>;
  transitionIssue(key: string, transitionId: string): Promise<void>;
};

export async function planSemanticIssueTransition(
  provider: TransitionPlanner,
  key: string,
  semantic: SemanticTransition,
): Promise<{
  key: string;
  alreadySatisfied: boolean;
  id?: string;
  name?: string;
  available: TransitionInfo[];
}> {
  const issue = await provider.getIssue(key);
  const raw = await provider.getTransitions(key);
  const available = parseJiraTransitions(
    Array.isArray(raw) ? { transitions: raw } : raw,
  );
  const resolved = resolveSemanticTransition({
    semantic,
    available,
    mapping: provider.config.transitions,
    issueKey: key,
    currentStatus: issue.status,
    currentStatusCategory: issue.statusCategory,
  });
  if (resolved.alreadySatisfied) {
    return { key, alreadySatisfied: true, available };
  }
  const id = assertNumericTransitionId(resolved.id, {
    issueKey: key,
    semanticAction: semantic,
  });
  return {
    key,
    alreadySatisfied: false,
    id,
    name: resolved.name,
    available,
  };
}

export async function applySemanticIssueTransition(
  provider: TransitionPlanner,
  key: string,
  semantic: SemanticTransition,
): Promise<{
  alreadySatisfied: boolean;
  id?: string;
  name?: string;
  available: TransitionInfo[];
}> {
  const plan = await planSemanticIssueTransition(provider, key, semantic);
  if (plan.alreadySatisfied || !plan.id) {
    return { alreadySatisfied: true, available: plan.available };
  }
  await provider.transitionIssue(key, plan.id);
  return {
    alreadySatisfied: false,
    id: plan.id,
    name: plan.name,
    available: plan.available,
  };
}
