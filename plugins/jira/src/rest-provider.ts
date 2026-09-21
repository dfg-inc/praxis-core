import type { JiraConfig } from "./config.js";
import { patSupportedForVersion } from "./config.js";
import type {
  CreateIssueInput,
  JiraComment,
  JiraIssueLite,
  JiraLink,
  JiraProvider,
  JiraUser,
  MetadataContext,
  Transition,
} from "./provider.js";
import type { PraxisRichTextDocument } from "@praxis/contracts";
import { renderRichText } from "./rich-text.js";
import {
  contextualTransportError,
  isAbortError,
  isHttpNotFound,
  isTransientError,
  isTransientHttp,
  jiraRequestTimeoutMs,
  mergeAbortSignals,
  readJiraResponseJson,
  sleepBackoff,
} from "./http.js";
import {
  buildIssueTypeMapping,
  resolveSemanticType,
  type IssueTypeMapping,
  type RawIssueType,
} from "./issue-types.js";
import {
  assertNumericTransitionId,
  parseJiraTransitions,
  parseNumericTransitionId,
  transitionPostBody,
  JiraTransitionError,
} from "./transitions.js";

type StoredIssue = JiraIssueLite & {
  comments: JiraComment[];
  attachments: { id: string; filename: string }[];
  properties: Record<string, unknown>;
};

export type MockIssueType = RawIssueType & { id: string; name: string };

export const DEFAULT_MOCK_ISSUE_TYPES: MockIssueType[] = [
  { id: "10000", name: "Epic", hierarchyLevel: 1, subtask: false },
  { id: "10001", name: "Story", hierarchyLevel: 0, subtask: false },
  { id: "10002", name: "Task", hierarchyLevel: 0, subtask: false },
  { id: "10003", name: "Bug", hierarchyLevel: 0, subtask: false },
  { id: "10004", name: "Sub-task", hierarchyLevel: -1, subtask: true },
  { id: "10005", name: "Work Package", hierarchyLevel: 0, subtask: false },
];

export const LOCALIZED_RU_ISSUE_TYPES: MockIssueType[] = [
  { id: "10000", name: "Эпик", hierarchyLevel: 1, subtask: false },
  { id: "10001", name: "История", hierarchyLevel: 0, subtask: false },
  { id: "10002", name: "Задача", hierarchyLevel: 0, subtask: false },
  { id: "10003", name: "Ошибка", hierarchyLevel: 0, subtask: false },
  { id: "10012", name: "Баг", hierarchyLevel: 0, subtask: false },
  { id: "10004", name: "Подзадача", hierarchyLevel: -1, subtask: true },
  { id: "10005", name: "Work Package", hierarchyLevel: 0, subtask: false },
];

export type MockTransition = {
  id: string;
  name: string;
  to?: {
    id?: string;
    name?: string;
    statusCategory?: { id?: number; key?: string; name?: string };
  };
};

export const DEFAULT_MOCK_TRANSITIONS: MockTransition[] = [
  {
    id: "11",
    name: "To Do",
    to: {
      id: "10000",
      name: "To Do",
      statusCategory: { key: "new", name: "To Do" },
    },
  },
  {
    id: "21",
    name: "In Progress",
    to: {
      id: "10001",
      name: "In Progress",
      statusCategory: { key: "indeterminate", name: "In Progress" },
    },
  },
  {
    id: "31",
    name: "Done",
    to: {
      id: "10002",
      name: "Done",
      statusCategory: { key: "done", name: "Done" },
    },
  },
];

export const LOCALIZED_RU_TRANSITIONS: MockTransition[] = [
  {
    id: "11",
    name: "К выполнению",
    to: {
      id: "10000",
      name: "К выполнению",
      statusCategory: { key: "new", name: "К выполнению" },
    },
  },
  {
    id: "21",
    name: "В работу",
    to: {
      id: "10001",
      name: "В работе",
      statusCategory: { key: "indeterminate", name: "В работе" },
    },
  },
  {
    id: "31",
    name: "Готово",
    to: {
      id: "10002",
      name: "Готово",
      statusCategory: { key: "done", name: "Готово" },
    },
  },
];

export type MockJiraState = {
  nextId: number;
  createIssueCount: number;
  issues: Map<string, StoredIssue>;
  links: JiraLink[];
  versions: { id: string; name: string }[];
  claimLocks: Map<string, string>;
  issueTypes: MockIssueType[];
  propertyPutStatus: number;
  availableTransitions: MockTransition[];
  transitionPostStatus: number;
  transitionPosts: { key: string; body: unknown }[];
};

export function createMockJiraState(
  extra: Partial<
    Pick<
      MockJiraState,
      | "issueTypes"
      | "propertyPutStatus"
      | "availableTransitions"
      | "transitionPostStatus"
    >
  > = {},
): MockJiraState {
  return {
    nextId: 1,
    createIssueCount: 0,
    issues: new Map(),
    links: [],
    versions: [],
    claimLocks: new Map(),
    issueTypes: extra.issueTypes ?? DEFAULT_MOCK_ISSUE_TYPES,
    propertyPutStatus: extra.propertyPutStatus ?? 200,
    availableTransitions: [...(extra.availableTransitions ?? DEFAULT_MOCK_TRANSITIONS)],
    transitionPostStatus: extra.transitionPostStatus ?? 204,
    transitionPosts: [],
  };
}

function findStored(state: MockJiraState, idOrKey: string): StoredIssue | undefined {
  return (
    state.issues.get(idOrKey) ??
    [...state.issues.values()].find((i) => i.id === idOrKey)
  );
}

function issueFields(issue: StoredIssue) {
  const statusCategoryKey = issue.statusCategory ?? "new";
  return {
    ...issue.fields,
    summary: issue.summary,
    description: issue.description ?? "",
    status: {
      name: issue.status,
      statusCategory: { key: statusCategoryKey, name: issue.status },
    },
    issuetype: {
      name: issue.issueType,
      id: issue.issueTypeId ?? issue.issueType,
      hierarchyLevel: issue.hierarchyLevel,
    },
    labels: issue.labels,
    parent: issue.parentKey ? { key: issue.parentKey } : undefined,
    assignee: issue.assignee,
  };
}

export function createMockFetch(
  state: MockJiraState,
  opts: { flavor: "cloud" | "datacenter"; projectKey: string },
): typeof fetch {
  const prefix =
    opts.flavor === "cloud" ? "/rest/api/3" : "/rest/api/2";

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const notFound = () => json({ errorMessages: ["not found"] }, 404);

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://mock.jira.local");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "GET" && path.endsWith("/myself")) {
      return json({
        displayName: "Praxis Bot",
        accountId: "acct-praxis",
        name: "praxis",
      });
    }
    if (method === "GET" && path.endsWith("/serverInfo")) {
      return json({
        version: opts.flavor === "cloud" ? "1001.0.0" : "9.12.0",
        deploymentType: opts.flavor === "cloud" ? "Cloud" : "Server",
        baseUrl: url.origin,
      });
    }
    if (method === "GET" && path.endsWith("/project/" + opts.projectKey)) {
      return json({ id: "10000", key: opts.projectKey, name: opts.projectKey });
    }
    if (method === "GET" && path.endsWith("/issuetype")) {
      return json(state.issueTypes);
    }
    if (method === "GET" && path.endsWith("/field")) {
      return json([
        { id: "summary", name: "Summary" },
        { id: "customfield_story_points", name: "Story Points" },
        { id: "customfield_architect_estimate", name: "Architect Estimate" },
      ]);
    }
    if (method === "GET" && path.includes(`/project/${opts.projectKey}/version`)) {
      return json({ values: state.versions });
    }
    if (method === "POST" && path.includes(`/version`)) {
      const v = { id: `v${state.versions.length + 1}`, name: body.name };
      state.versions.push(v);
      return json(v, 201);
    }

    const search = path.endsWith("/search") || path.endsWith("/search/jql");
    if (method === "GET" && search) {
      const jql = url.searchParams.get("jql") ?? "";
      const issues = [...state.issues.values()].filter((i) =>
        matchJql(i, jql),
      );
      return json({
        issues: issues.map((i) => ({
          id: i.id,
          key: i.key,
          fields: issueFields(i),
        })),
      });
    }
    if (method === "POST" && search) {
      const jql = body.jql ?? "";
      const issues = [...state.issues.values()].filter((i) =>
        matchJql(i, jql),
      );
      return json({
        issues: issues.map((i) => ({
          id: i.id,
          key: i.key,
          fields: issueFields(i),
        })),
      });
    }

    if (method === "POST" && /\/issue$/.test(path)) {
      state.createIssueCount += 1;
      const keyNew = `${opts.projectKey}-${state.nextId++}`;
      const fields = body.fields ?? {};
      const requested = fields.issuetype as RawIssueType | undefined;
      const catalog = state.issueTypes;
      const resolvedType =
        catalog.find((t) => requested?.id && t.id === String(requested.id)) ??
        catalog.find(
          (t) =>
            requested?.name &&
            t.name.toLowerCase() === String(requested.name).toLowerCase(),
        ) ??
        catalog.find((t) => t.name === "Task" || t.name === "Задача") ??
        catalog[2];
      const stored: StoredIssue = {
        id: String(10000 + Number(keyNew.split("-").pop())),
        key: keyNew,
        summary: fields.summary,
        description: fields.description,
        status: "To Do",
        statusCategory: "new",
        issueType: resolvedType?.name ?? String(requested?.name ?? "Task"),
        issueTypeId: resolvedType?.id,
        semanticType: "unknown",
        hierarchyLevel: resolvedType?.hierarchyLevel,
        labels: fields.labels ?? [],
        parentKey: fields.parent?.key,
        fields: { ...fields },
        comments: [],
        attachments: [],
        properties: {},
      };
      state.issues.set(keyNew, stored);
      return json({ key: keyNew, id: stored.id }, 201);
    }

    const issueMatch = path.match(/\/issue\/([^/]+)(.*)$/);
    if (issueMatch && !path.includes("/issueLink")) {
      const key = decodeURIComponent(issueMatch[1] ?? "");
      const rest = issueMatch[2] ?? "";
      const issue = findStored(state, key);
      if (method === "GET" && rest.startsWith("/comment")) {
        if (!issue) return notFound();
        const startAt = Number(url.searchParams.get("startAt") ?? 0);
        const maxResults = Number(url.searchParams.get("maxResults") ?? issue.comments.length);
        const slice = issue.comments.slice(
          Number.isFinite(startAt) ? startAt : 0,
          (Number.isFinite(startAt) ? startAt : 0) + (Number.isFinite(maxResults) ? maxResults : issue.comments.length),
        );
        return json({
          comments: slice,
          startAt: Number.isFinite(startAt) ? startAt : 0,
          maxResults: slice.length,
          total: issue.comments.length,
        });
      }
      if (method === "POST" && rest.startsWith("/comment") && rest === "/comment") {
        if (!issue) return notFound();
        const c = {
          id: `c${issue.comments.length + 1}`,
          body: body.body ?? body,
          author: "praxis",
        };
        issue.comments.push(c);
        return json(c, 201);
      }
      const putComment = rest.match(/^\/comment\/([^/]+)$/);
      if (method === "PUT" && putComment) {
        if (!issue) return notFound();
        const hit = issue.comments.find((c) => c.id === putComment[1]);
        if (!hit) return notFound();
        hit.body = body.body ?? body;
        return json(hit);
      }
      if (method === "POST" && rest.startsWith("/attachments")) {
        if (!issue) return notFound();
        const att = { id: `a${issue.attachments.length + 1}`, filename: "file" };
        issue.attachments.push(att);
        return json([att], 200);
      }
      if (method === "GET" && rest.includes("/transitions")) {
        return json({
          transitions: state.availableTransitions,
        });
      }
      if (method === "POST" && rest.includes("/transitions")) {
        state.transitionPosts.push({ key, body: body?.transition ?? body });
        if (!issue) return notFound();
        const rawId = body?.transition?.id;
        if (!parseNumericTransitionId(rawId)) {
          return json(
            {
              errorMessages: [
                "идентификатор «изменение состояния» должен быть целым числом",
              ],
            },
            400,
          );
        }
        if (state.transitionPostStatus !== 204) {
          return json(
            { errorMessages: ["transition failed"] },
            state.transitionPostStatus,
          );
        }
        const hit = state.availableTransitions.find(
          (t) => t.id === String(rawId).trim(),
        );
        if (hit?.to?.name) issue.status = hit.to.name;
        else if (hit?.name) issue.status = hit.name;
        if (hit?.to?.statusCategory?.key) {
          issue.statusCategory = hit.to.statusCategory.key;
        }
        return new Response(null, { status: 204 });
      }
      if (method === "PUT" && rest.startsWith("/assignee")) {
        if (!issue) return notFound();
        issue.assignee = {
          accountId: body.accountId ?? body.name ?? "acct",
          displayName: String(body.accountId ?? body.name ?? "acct"),
        };
        return new Response(null, { status: 204 });
      }
      if (method === "GET" && (rest === "/properties" || rest === "/properties/")) {
        if (!issue) return notFound();
        return json({
          keys: Object.keys(issue.properties).map((k) => ({ key: k })),
        });
      }
      const propMatch = rest.match(/^\/properties\/(.+)$/);
      if (propMatch) {
        if (!issue) return notFound();
        const pk = decodeURIComponent(propMatch[1] ?? "");
        if (method === "GET") {
          if (!(pk in issue.properties)) return json({ error: "missing" }, 404);
          return json({ key: pk, value: issue.properties[pk] });
        }
        if (method === "PUT") {
          issue.properties[pk] = body;
          if (state.propertyPutStatus === 204) {
            return new Response(null, { status: 204 });
          }
          return new Response("", {
            status: state.propertyPutStatus,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      if (method === "GET" && (rest === "" || rest.startsWith("?"))) {
        if (!issue) return notFound();
        return json({
          id: issue.id,
          key: issue.key,
          fields: {
            ...issueFields(issue),
            issuelinks: state.links
              .filter((l) => l.inwardKey === key || l.outwardKey === key)
              .map((l) => ({
                type: { name: l.type },
                inwardIssue:
                  l.inwardKey === key
                    ? undefined
                    : {
                        key: l.inwardKey,
                        fields: {
                          status: {
                            name: state.issues.get(l.inwardKey)?.status,
                          },
                        },
                      },
                outwardIssue:
                  l.outwardKey === key
                    ? undefined
                    : {
                        key: l.outwardKey,
                        fields: {
                          status: {
                            name: state.issues.get(l.outwardKey)?.status,
                          },
                        },
                      },
              })),
          },
        });
      }
      if (method === "PUT" && (rest === "" || rest.startsWith("?"))) {
        if (!issue) return notFound();
        const fields = body.fields ?? {};
        if (fields.summary) issue.summary = fields.summary;
        if (fields.description !== undefined)
          issue.description = fields.description;
        if (fields.labels) issue.labels = fields.labels;
        if (fields.assignee)
          issue.assignee = {
            accountId: fields.assignee.accountId ?? "acct",
            displayName: fields.assignee.accountId ?? "acct",
          };
        if (fields.parent) issue.parentKey = fields.parent.key;
        Object.assign(issue.fields, fields);
        return new Response(null, { status: 204 });
      }
    }

    if (method === "POST" && path.endsWith("/issueLink")) {
      state.links.push({
        type: body.type?.name ?? "Relates",
        inwardKey: body.inwardIssue.key,
        outwardKey: body.outwardIssue.key,
      });
      return new Response(null, { status: 201 });
    }

    return json({ errorMessages: [`unhandled ${method} ${path}`] }, 500);
  }) as typeof fetch;
}

function matchJql(issue: StoredIssue, jql: string): boolean {
  if (!jql) return true;
  const parent = jql.match(/parent\s*=\s*(\S+)/i);
  if (parent && issue.parentKey !== parent[1].replace(/"/g, "")) return false;
  const epic = jql.match(/"Epic Link"\s*=\s*(\S+)/i);
  if (epic && issue.parentKey !== epic[1].replace(/"/g, "")) return false;
  const key = jql.match(/key\s*=\s*(\S+)/i);
  if (key && issue.key !== key[1].replace(/"/g, "")) return false;
  const type = jql.match(/issuetype\s*=\s*(\S+)/i);
  if (type) {
    const t = type[1].replace(/"/g, "");
    if (issue.issueType !== t && issue.issueTypeId !== t) return false;
  }
  const project = jql.match(/project\s*=\s*(\S+)/i);
  if (project && !issue.key.startsWith(project[1].replace(/"/g, "")))
    return false;
  const labels = jql.match(/labels\s*=\s*(\S+)/i);
  if (labels && !issue.labels.includes(labels[1].replace(/"/g, "")))
    return false;
  return true;
}

export class RestJiraProvider implements JiraProvider {
  readonly flavor: "cloud" | "datacenter";
  readonly config: JiraConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly abortSignal?: AbortSignal;
  private readonly timeoutMs: number;
  private meta?: MetadataContext;
  private typeMapping?: IssueTypeMapping;

  constructor(opts: {
    config: JiraConfig;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) {
    this.config = opts.config;
    this.flavor = opts.config.mode;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.abortSignal = opts.signal;
    this.timeoutMs = opts.timeoutMs ?? jiraRequestTimeoutMs();
  }

  private apiPrefix(): string {
    return this.flavor === "cloud" ? "/rest/api/3" : "/rest/api/2";
  }

  headers(): HeadersInit {
    if (this.flavor === "cloud") {
      const basic = Buffer.from(
        `${this.config.email}:${this.config.token}`,
      ).toString("base64");
      return {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      };
    }
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  lastAuthHeader(): string {
    return String((this.headers() as Record<string, string>).Authorization);
  }

  private requestSignal(): AbortSignal | undefined {
    const timeout =
      typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(this.timeoutMs)
        : undefined;
    return mergeAbortSignals([this.abortSignal, timeout]);
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const maxAttempts = 3;
    const write = method !== "GET" && method !== "HEAD";
    const retryWrites = method === "PUT";
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(this.url(path), {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: this.requestSignal(),
        });
        if (
          !res.ok &&
          isTransientHttp(res.status) &&
          (!write || retryWrites) &&
          attempt < maxAttempts
        ) {
          await sleepBackoff(attempt, res.headers.get("retry-after"));
          continue;
        }
        return await readJiraResponseJson<T>(res, method, path);
      } catch (err) {
        lastErr = err;
        if (isAbortError(err)) {
          throw contextualTransportError(err, {
            provider: this.flavor,
            method,
            path,
            attempt,
          });
        }
        if (
          isTransientError(err) &&
          (!write || retryWrites) &&
          attempt < maxAttempts
        ) {
          await sleepBackoff(attempt, undefined);
          continue;
        }
        throw contextualTransportError(err, {
          provider: this.flavor,
          method,
          path,
          attempt,
        });
      }
    }
    throw contextualTransportError(lastErr, {
      provider: this.flavor,
      method,
      path,
      attempt: maxAttempts,
    });
  }

  renderDescription(doc: PraxisRichTextDocument): unknown {
    return renderRichText(doc, this.flavor);
  }

  async verifyConnection() {
    const me = await this.getCurrentUser();
    const info = await this.getServerInfo();
    if (this.flavor === "datacenter" && info.version) {
      const pat = patSupportedForVersion(info.version);
      if (!pat.supported) {
        return {
          ok: false,
          displayName: me.displayName,
          version: info.version,
          deploymentType: info.deploymentType,
          patSupported: false,
          guidance: pat.guidance,
        };
      }
    }
    return {
      ok: true,
      displayName: me.displayName,
      version: info.version,
      deploymentType: info.deploymentType,
      patSupported: this.flavor === "datacenter",
    };
  }

  async getServerInfo() {
    const raw = await this.requestJson<{
      version?: string;
      deploymentType?: string;
      baseUrl?: string;
    }>("GET", `${this.apiPrefix()}/serverInfo`);
    return {
      version: raw.version,
      deploymentType: raw.deploymentType,
      baseUrl: raw.baseUrl ?? this.config.baseUrl,
    };
  }

  async getCurrentUser(): Promise<JiraUser> {
    const raw = await this.requestJson<{
      displayName?: string;
      accountId?: string;
      name?: string;
      emailAddress?: string;
    }>("GET", `${this.apiPrefix()}/myself`);
    return {
      accountId: raw.accountId ?? raw.name ?? "unknown",
      displayName: raw.displayName ?? "unknown",
      emailAddress: raw.emailAddress,
    };
  }

  async getProject() {
    return this.requestJson<{ key: string; name: string; id: string }>(
      "GET",
      `${this.apiPrefix()}/project/${this.config.projectKey}`,
    );
  }

  async getIssueTypes() {
    return this.requestJson<RawIssueType[]>(
      "GET",
      `${this.apiPrefix()}/issuetype`,
    );
  }

  async getFields() {
    return this.requestJson<{ id: string; name: string }[]>(
      "GET",
      `${this.apiPrefix()}/field`,
    );
  }

  async getVersions() {
    const raw = await this.requestJson<{ values?: { id: string; name: string }[] }>(
      "GET",
      `${this.apiPrefix()}/project/${this.config.projectKey}/version`,
    );
    return raw.values ?? [];
  }

  async createVersion(name: string) {
    return this.requestJson<{ id: string; name: string }>(
      "POST",
      `${this.apiPrefix()}/version`,
      { name, project: this.config.projectKey },
    );
  }

  async discoverMetadata(): Promise<MetadataContext> {
    const [types, fields, versions] = await Promise.all([
      this.getIssueTypes(),
      this.getFields(),
      this.getVersions(),
    ]);
    const mapping = buildIssueTypeMapping(types ?? [], this.config);
    this.typeMapping = mapping;
    this.meta = {
      epicTypeId: mapping.epicTypeId ?? this.config.epicTypeId ?? "",
      storyTypeId: mapping.storyTypeId ?? this.config.storyTypeId ?? "",
      taskTypeId: mapping.taskTypeId ?? this.config.taskTypeId ?? "",
      bugTypeId: mapping.bugTypeId ?? this.config.bugTypeId ?? "",
      workPackageTypeId: mapping.workPackageTypeId,
      issueTypes: mapping.types,
      fields,
      versions,
      transitionsByName: { ...this.config.transitions },
    };
    return this.meta;
  }

  private mapIssue(raw: {
    id?: string;
    key?: string;
    fields?: Record<string, unknown>;
  }): JiraIssueLite {
    const fields = raw.fields ?? {};
    const status = fields.status as {
      name?: string;
      statusCategory?: { key?: string };
    } | undefined;
    const type = fields.issuetype as RawIssueType | undefined;
    const parent = fields.parent as { key?: string } | undefined;
    const assignee = fields.assignee as JiraUser | undefined;
    const semanticType = resolveSemanticType(
      type ?? {},
      this.typeMapping,
      this.config,
    );
    return {
      id: String(raw.id ?? ""),
      key: String(raw.key ?? ""),
      summary: String(fields.summary ?? ""),
      description: fields.description,
      status: status?.name ?? "To Do",
      issueType: type?.name ?? "",
      issueTypeId: type?.id ? String(type.id) : undefined,
      semanticType,
      hierarchyLevel: type?.hierarchyLevel,
      labels: Array.isArray(fields.labels) ? (fields.labels as string[]) : [],
      parentKey: parent?.key,
      assignee,
      statusCategory:
        typeof status?.statusCategory?.key === "string"
          ? status.statusCategory.key
          : undefined,
      fields,
      properties: {},
    };
  }

  private assertIssueKey(issue: JiraIssueLite): void {
    if (!issue.key) {
      throw new Error(
        `Jira issue missing key (id=${issue.id || "unknown"}); search/children result was not hydrated`,
      );
    }
  }

  async listIssueProperties(key: string): Promise<string[]> {
    try {
      const raw = await this.requestJson<{ keys?: { key: string }[] }>(
        "GET",
        `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/properties`,
      );
      return (raw.keys ?? []).map((k) => k.key);
    } catch (err) {
      if (isAbortError(err)) throw err;
      return [];
    }
  }

  private async loadPraxisProperties(
    key: string,
  ): Promise<Record<string, unknown>> {
    const names = (await this.listIssueProperties(key)).filter((n) =>
      n.startsWith("praxis."),
    );
    const properties: Record<string, unknown> = {};
    await Promise.all(
      names.map(async (name) => {
        const value = await this.getIssueProperty(key, name);
        if (value !== undefined) properties[name] = value;
      }),
    );
    return properties;
  }

  private async hydrateIssue(raw: {
    id?: string;
    key?: string;
    fields?: Record<string, unknown>;
  }): Promise<JiraIssueLite> {
    let issue = this.mapIssue(raw);
    if (!issue.key || !issue.summary) {
      const idOrKey = issue.key || issue.id;
      if (!idOrKey) {
        throw new Error("Jira search hit has neither key nor id");
      }
      const full = await this.requestJson<{
        id: string;
        key: string;
        fields: Record<string, unknown>;
      }>("GET", `${this.apiPrefix()}/issue/${encodeURIComponent(idOrKey)}`);
      issue = this.mapIssue(full);
    }
    this.assertIssueKey(issue);
    issue.properties = await this.loadPraxisProperties(issue.key);
    return issue;
  }

  async getIssue(key: string): Promise<JiraIssueLite> {
    const raw = await this.requestJson<{
      id: string;
      key: string;
      fields: Record<string, unknown>;
    }>("GET", `${this.apiPrefix()}/issue/${encodeURIComponent(key)}`);
    const issue = this.mapIssue(raw);
    this.assertIssueKey(issue);
    issue.properties = await this.loadPraxisProperties(issue.key);
    return issue;
  }

  async searchIssues(jql: string): Promise<JiraIssueLite[]> {
    const fields = [
      "summary",
      "status",
      "issuetype",
      "labels",
      "parent",
      "assignee",
      "description",
    ];
    if (this.flavor === "datacenter") {
      const viaGet = await this.requestJson<{
        issues: { id: string; key: string; fields: Record<string, unknown> }[];
      }>(
        "GET",
        `${this.apiPrefix()}/search?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields.join(","))}`,
      );
      const issues: JiraIssueLite[] = [];
      for (const i of viaGet.issues ?? []) issues.push(await this.hydrateIssue(i));
      return issues;
    }
    const raw = await this.requestJson<{
      issues?: { id?: string; key?: string; fields?: Record<string, unknown> }[];
      values?: { id?: string; key?: string; fields?: Record<string, unknown> }[];
    }>("POST", `${this.apiPrefix()}/search/jql`, {
      jql,
      maxResults: 100,
      fields,
    });
    const hits = raw.issues ?? raw.values ?? [];
    const issues: JiraIssueLite[] = [];
    for (const i of hits) issues.push(await this.hydrateIssue(i));
    return issues;
  }

  async getIssues(jql: string): Promise<JiraIssueLite[]> {
    return this.searchIssues(jql);
  }

  async getChildren(parentKey: string): Promise<JiraIssueLite[]> {
    return this.searchIssues(`parent = ${parentKey} OR "Epic Link" = ${parentKey}`);
  }

  async getParent(key: string): Promise<JiraIssueLite | null> {
    const issue = await this.getIssue(key);
    if (!issue.parentKey) return null;
    return this.getIssue(issue.parentKey);
  }

  async createIssue(input: CreateIssueInput) {
    if (!this.typeMapping) await this.discoverMetadata();
    const mapping = this.typeMapping ?? buildIssueTypeMapping([], this.config);
    const semantic = resolveSemanticType(
      { name: input.issueType, id: input.issueTypeId },
      mapping,
      this.config,
    );
    const idFromSemantic =
      semantic === "epic"
        ? mapping.epicTypeId
        : semantic === "story"
          ? mapping.storyTypeId
          : semantic === "task"
            ? mapping.taskTypeId
            : semantic === "bug"
              ? mapping.bugTypeId
              : semantic === "work-package"
                ? mapping.workPackageTypeId
                : undefined;
    const typeId = input.issueTypeId || idFromSemantic;
    const issuetype = typeId ? { id: typeId } : { name: input.issueType };
    const body = {
      fields: {
        project: { key: this.config.projectKey },
        summary: input.summary,
        issuetype,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.parentKey ? { parent: { key: input.parentKey } } : {}),
        ...(input.labels ? { labels: input.labels } : {}),
        ...(input.fields ?? {}),
      },
    };
    return this.requestJson<{ key: string; id: string }>(
      "POST",
      `${this.apiPrefix()}/issue`,
      body,
    );
  }

  async updateIssue(key: string, fields: Record<string, unknown>) {
    await this.requestJson(
      "PUT",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}`,
      { fields },
    );
  }

  async assignIssue(key: string, accountId: string) {
    const body =
      this.flavor === "cloud"
        ? { accountId }
        : { name: accountId, accountId };
    await this.requestJson(
      "PUT",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/assignee`,
      body,
    );
  }

  async getTransitions(key: string): Promise<Transition[]> {
    const raw = await this.requestJson<unknown>(
      "GET",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/transitions`,
    );
    return parseJiraTransitions(raw).map((t) => ({
      id: t.id,
      name: t.name,
      to: {
        id: t.toStatusId,
        name: t.toStatus,
        statusCategory: t.toStatusCategory
          ? { key: t.toStatusCategory }
          : undefined,
      },
    }));
  }

  async transitionIssue(key: string, transitionId: string) {
    const id = assertNumericTransitionId(transitionId, { issueKey: key });
    const available = parseJiraTransitions({
      transitions: await this.getTransitions(key),
    });
    const hit = available.find((t) => t.id === id);
    if (!hit) {
      throw new JiraTransitionError(
        "JIRA_TRANSITION_NOT_AVAILABLE",
        `transition ${id} is not currently available for ${key}`,
        {
          issueKey: key,
          resolvedValue: id,
          available: available.map((t) => ({
            id: t.id,
            name: t.name,
            toStatus: t.toStatus,
          })),
        },
      );
    }
    await this.requestJson(
      "POST",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/transitions`,
      transitionPostBody(id),
    );
  }

  async addComment(key: string, body: unknown) {
    return this.requestJson<{ id: string }>(
      "POST",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/comment`,
      { body },
    );
  }

  async updateComment(key: string, commentId: string, body: unknown) {
    return this.requestJson<{ id: string }>(
      "PUT",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`,
      { body },
    );
  }

  async getComments(key: string): Promise<JiraComment[]> {
    const all: JiraComment[] = [];
    let startAt = 0;
    const pageSize = 100;
    for (let i = 0; i < 100; i += 1) {
      const raw = await this.requestJson<{
        comments?: JiraComment[];
        startAt?: number;
        maxResults?: number;
        total?: number;
      }>(
        "GET",
        `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=${pageSize}`,
      );
      const batch = raw.comments ?? [];
      all.push(...batch);
      const total = raw.total ?? all.length;
      if (batch.length === 0 || all.length >= total || batch.length < pageSize) break;
      startAt += batch.length;
    }
    return all;
  }

  async addAttachment(
    key: string,
    filename: string,
    _contentType: string,
    _body: Uint8Array,
  ) {
    return this.requestJson<{ id: string; filename: string }[]>(
      "POST",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/attachments`,
      { filename },
    ).then((rows) => rows[0] ?? { id: "att", filename });
  }

  async getAttachments(key: string) {
    const issue = await this.getIssue(key);
    const atts = issue.fields.attachment as
      | { id: string; filename: string }[]
      | undefined;
    return atts ?? [];
  }

  async createIssueLink(
    inwardKey: string,
    outwardKey: string,
    type = "Relates",
  ) {
    await this.requestJson("POST", `${this.apiPrefix()}/issueLink`, {
      type: { name: type },
      inwardIssue: { key: inwardKey },
      outwardIssue: { key: outwardKey },
    });
  }

  async getIssueLinks(key: string): Promise<JiraLink[]> {
    const issue = await this.getIssue(key);
    const links = (issue.fields.issuelinks as unknown[]) ?? [];
    const out: JiraLink[] = [];
    for (const raw of links) {
      const l = raw as {
        type: { name: string };
        inwardIssue?: { key: string };
        outwardIssue?: { key: string };
      };
      if (l.inwardIssue)
        out.push({
          type: l.type.name,
          inwardKey: l.inwardIssue.key,
          outwardKey: key,
        });
      if (l.outwardIssue)
        out.push({
          type: l.type.name,
          inwardKey: key,
          outwardKey: l.outwardIssue.key,
        });
    }
    return out;
  }

  async setFixVersion(key: string, versionName: string) {
    await this.updateIssue(key, { fixVersions: [{ name: versionName }] });
  }

  async setIssueProperty(key: string, propertyKey: string, value: unknown) {
    await this.requestJson(
      "PUT",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propertyKey)}`,
      value,
    );
  }

  async getIssueProperty<T = unknown>(
    key: string,
    propertyKey: string,
  ): Promise<T | undefined> {
    try {
      const raw = await this.requestJson<{ value: T }>(
        "GET",
        `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propertyKey)}`,
      );
      return raw?.value;
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (isHttpNotFound(err)) return undefined;
      return undefined;
    }
  }

  async writePraxisState(key: string, state: unknown) {
    await this.setIssueProperty(key, "praxis.state", state);
  }

  async readPraxisState<T = unknown>(key: string): Promise<T | undefined> {
    return this.getIssueProperty<T>(key, "praxis.state");
  }

  async writeArchitectureMetadata(key: string, value: unknown) {
    await this.setIssueProperty(key, "praxis.architecture", value);
  }

  async readArchitectureMetadata<T = unknown>(
    key: string,
  ): Promise<T | undefined> {
    return this.getIssueProperty<T>(key, "praxis.architecture");
  }
}

export function createJiraProvider(opts: {
  config: JiraConfig;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): JiraProvider {
  return new RestJiraProvider(opts);
}
