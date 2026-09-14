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

type StoredIssue = JiraIssueLite & {
  comments: JiraComment[];
  attachments: { id: string; filename: string }[];
  properties: Record<string, unknown>;
};

export type MockJiraState = {
  nextId: number;
  createIssueCount: number;
  issues: Map<string, StoredIssue>;
  links: JiraLink[];
  versions: { id: string; name: string }[];
  claimLocks: Map<string, string>;
};

export function createMockJiraState(): MockJiraState {
  return {
    nextId: 1,
    createIssueCount: 0,
    issues: new Map(),
    links: [],
    versions: [],
    claimLocks: new Map(),
  };
}

function issueFields(issue: StoredIssue) {
  return {
    summary: issue.summary,
    description: issue.description ?? "",
    status: { name: issue.status },
    issuetype: { name: issue.issueType, id: issue.issueType },
    labels: issue.labels,
    parent: issue.parentKey ? { key: issue.parentKey } : undefined,
    assignee: issue.assignee,
    ...issue.fields,
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
      return json([
        { id: "1", name: "Epic" },
        { id: "2", name: "Story" },
        { id: "3", name: "Task" },
        { id: "4", name: "Bug" },
        { id: "5", name: "Work Package" },
      ]);
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
      const stored: StoredIssue = {
        id: String(state.nextId),
        key: keyNew,
        summary: fields.summary,
        description: fields.description,
        status: "To Do",
        issueType: fields.issuetype?.name ?? "Task",
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
      const issue = state.issues.get(key);
      if (method === "GET" && rest.startsWith("/comment")) {
        if (!issue) return notFound();
        return json({ comments: issue.comments });
      }
      if (method === "POST" && rest.startsWith("/comment")) {
        if (!issue) return notFound();
        const c = {
          id: `c${issue.comments.length + 1}`,
          body: body.body ?? body,
          author: "praxis",
        };
        issue.comments.push(c);
        return json(c, 201);
      }
      if (method === "POST" && rest.startsWith("/attachments")) {
        if (!issue) return notFound();
        const att = { id: `a${issue.attachments.length + 1}`, filename: "file" };
        issue.attachments.push(att);
        return json([att], 200);
      }
      if (method === "GET" && rest.includes("/transitions")) {
        return json({
          transitions: [
            { id: "11", name: "To Do" },
            { id: "21", name: "In Progress" },
            { id: "31", name: "Done" },
          ],
        });
      }
      if (method === "POST" && rest.includes("/transitions")) {
        if (!issue) return notFound();
        const name = body.transition?.name ?? body.transition?.id;
        const map: Record<string, string> = {
          "11": "To Do",
          "21": "In Progress",
          "31": "Done",
        };
        issue.status = map[String(name)] ?? String(name);
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
          return new Response(null, { status: 204 });
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
  if (type && issue.issueType !== type[1].replace(/"/g, "")) return false;
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
  private meta?: MetadataContext;

  constructor(opts: {
    config: JiraConfig;
    fetchImpl?: typeof fetch;
  }) {
    this.config = opts.config;
    this.flavor = opts.config.mode;
    this.fetchImpl = opts.fetchImpl ?? fetch;
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

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Jira ${method} ${path} failed: HTTP ${res.status} ${text}`,
      );
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return undefined as T;
    return (await res.json()) as T;
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
    return this.requestJson<{ id: string; name: string }[]>(
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
    const findType = (hint: string) =>
      types.find((t) => t.name.toLowerCase() === hint.toLowerCase())?.id ??
      hint;
    this.meta = {
      epicTypeId: findType(this.config.epicType),
      storyTypeId: findType(this.config.storyType),
      taskTypeId: findType(this.config.taskType),
      bugTypeId: findType(this.config.bugType),
      workPackageTypeId: this.config.workPackageType
        ? findType(this.config.workPackageType)
        : types.find((t) => t.name.toLowerCase() === "work package")?.id,
      issueTypes: types,
      fields,
      versions,
      transitionsByName: { ...this.config.transitions },
    };
    return this.meta;
  }

  private mapIssue(raw: {
    id: string;
    key: string;
    fields: Record<string, unknown>;
  }): JiraIssueLite {
    const fields = raw.fields ?? {};
    const status = fields.status as { name?: string } | undefined;
    const type = fields.issuetype as { name?: string } | undefined;
    const parent = fields.parent as { key?: string } | undefined;
    const assignee = fields.assignee as JiraUser | undefined;
    return {
      id: raw.id,
      key: raw.key,
      summary: String(fields.summary ?? ""),
      description: fields.description,
      status: status?.name ?? "To Do",
      issueType: type?.name ?? "Task",
      labels: Array.isArray(fields.labels) ? (fields.labels as string[]) : [],
      parentKey: parent?.key,
      assignee,
      fields,
    };
  }

  async getIssue(key: string): Promise<JiraIssueLite> {
    const raw = await this.requestJson<{
      id: string;
      key: string;
      fields: Record<string, unknown>;
    }>("GET", `${this.apiPrefix()}/issue/${encodeURIComponent(key)}`);
    return this.mapIssue(raw);
  }

  async searchIssues(jql: string): Promise<JiraIssueLite[]> {
    const path =
      this.flavor === "cloud"
        ? `${this.apiPrefix()}/search/jql`
        : `${this.apiPrefix()}/search`;
    const raw = await this.requestJson<{
      issues: { id: string; key: string; fields: Record<string, unknown> }[];
    }>(this.flavor === "cloud" ? "POST" : "GET", path, this.flavor === "cloud"
      ? { jql }
      : undefined);
    // DC uses query string
    if (this.flavor === "datacenter") {
      const viaGet = await this.requestJson<{
        issues: { id: string; key: string; fields: Record<string, unknown> }[];
      }>(
        "GET",
        `${this.apiPrefix()}/search?jql=${encodeURIComponent(jql)}`,
      );
      return (viaGet.issues ?? []).map((i) => this.mapIssue(i));
    }
    return (raw.issues ?? []).map((i) => this.mapIssue(i));
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
    const body = {
      fields: {
        project: { key: this.config.projectKey },
        summary: input.summary,
        issuetype: { name: input.issueType },
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
    const raw = await this.requestJson<{ transitions: Transition[] }>(
      "GET",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/transitions`,
    );
    return raw.transitions ?? [];
  }

  async transitionIssue(key: string, transitionIdOrName: string) {
    const transitions = await this.getTransitions(key);
    const hit =
      transitions.find((t) => t.id === transitionIdOrName) ??
      transitions.find(
        (t) => t.name.toLowerCase() === transitionIdOrName.toLowerCase(),
      );
    await this.requestJson(
      "POST",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/transitions`,
      {
        transition: hit
          ? { id: hit.id, name: hit.name }
          : { name: transitionIdOrName },
      },
    );
  }

  async addComment(key: string, body: unknown) {
    return this.requestJson<{ id: string }>(
      "POST",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/comment`,
      { body },
    );
  }

  async getComments(key: string): Promise<JiraComment[]> {
    const raw = await this.requestJson<{ comments: JiraComment[] }>(
      "GET",
      `${this.apiPrefix()}/issue/${encodeURIComponent(key)}/comment`,
    );
    return raw.comments ?? [];
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
      return raw.value;
    } catch {
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
}): JiraProvider {
  return new RestJiraProvider(opts);
}
