import {
  loadJiraConfig,
  patSupportedForVersion,
  type JiraConfig,
} from "./config.js";
import type {
  AttachDecisionLinkInput,
  Confirmer,
  CreateFeatureInput,
  CreateStoryInput,
  FetchLike,
  LinkIssuesInput,
  MutationPreview,
  SetArchitectEstimateInput,
  SetFixVersionInput,
} from "./types.js";

import { readJiraResponseJson } from "./http.js";

export type { JiraConfig } from "./config.js";
export { loadJiraConfig, patSupportedForVersion, parseJiraVersion } from "./config.js";
export type * from "./types.js";

let previewSeq = 0;

function nextPreviewId(): string {
  previewSeq += 1;
  return `preview-${previewSeq}`;
}

export class JiraClient {
  readonly config: JiraConfig;
  private readonly fetchImpl: FetchLike;

  constructor(opts?: {
    config?: JiraConfig;
    fetchImpl?: FetchLike;
    env?: NodeJS.ProcessEnv;
  }) {
    this.config = opts?.config ?? loadJiraConfig(opts?.env);
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  async verifyConnection(): Promise<{
    ok: boolean;
    displayName?: string;
    version?: string;
    patSupported: boolean;
    guidance?: string;
  }> {
    const meRes = await this.fetchImpl(this.url("/rest/api/2/myself"), {
      method: "GET",
      headers: this.headers(),
    });
    if (!meRes.ok) {
      throw new Error(`Jira verifyConnection failed: HTTP ${meRes.status}`);
    }
    const me = (await meRes.json()) as { displayName?: string };
    const infoRes = await this.fetchImpl(this.url("/rest/api/2/serverInfo"), {
      method: "GET",
      headers: this.headers(),
    });
    let version: string | undefined;
    if (infoRes.ok) {
      const info = (await infoRes.json()) as { version?: string };
      version = info.version;
    }
    if (version) {
      const pat = patSupportedForVersion(version);
      if (!pat.supported) {
        return {
          ok: false,
          displayName: me.displayName,
          version,
          patSupported: false,
          guidance: pat.guidance,
        };
      }
      return {
        ok: true,
        displayName: me.displayName,
        version,
        patSupported: true,
      };
    }
    return {
      ok: true,
      displayName: me.displayName,
      patSupported: true,
    };
  }

  /** Build a mutation preview; does not write. */
  previewMutation(
    summary: string,
    method: string,
    path: string,
    body?: unknown,
  ): MutationPreview {
    return {
      id: nextPreviewId(),
      summary,
      method,
      path,
      body,
    };
  }

  /**
   * Human gate: show preview externally, then execute only if confirmer returns true.
   * On reject, no network write is performed.
   */
  async confirmAndExecute<T>(
    preview: MutationPreview,
    confirmer: Confirmer,
    execute: () => Promise<T>,
  ): Promise<{ executed: false } | { executed: true; result: T }> {
    const approved = await confirmer(preview);
    if (!approved) {
      return { executed: false };
    }
    const result = await execute();
    return { executed: true, result };
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
    return readJiraResponseJson<T>(res, method, path);
  }

  createFeaturePreview(input: CreateFeatureInput): MutationPreview {
    const body = {
      fields: {
        project: { key: this.config.projectKey },
        summary: input.summary,
        description: input.description ?? "",
        issuetype: { name: input.issueType ?? "New Feature" },
      },
    };
    return this.previewMutation(
      `Create feature: ${input.summary}`,
      "POST",
      "/rest/api/2/issue",
      body,
    );
  }

  async createFeature(
    input: CreateFeatureInput,
    confirmer: Confirmer,
  ): Promise<{ executed: false } | { executed: true; result: { key: string } }> {
    const preview = this.createFeaturePreview(input);
    return this.confirmAndExecute(preview, confirmer, () =>
      this.requestJson<{ key: string }>(preview.method, preview.path, preview.body),
    );
  }

  createStoryPreview(input: CreateStoryInput): MutationPreview {
    if (typeof input.estimateHours === "number" && input.estimateHours > 8) {
      throw new Error(
        `story estimate ${input.estimateHours}h exceeds 8h ceiling — split the scenario before creating a Story`,
      );
    }
    const description = `Acceptance Criteria:\n\n${input.acceptanceCriteria}`;
    const body = {
      fields: {
        project: { key: this.config.projectKey },
        summary: input.summary,
        description,
        issuetype: { name: input.issueType ?? "Story" },
        ...(input.parentKey
          ? { parent: { key: input.parentKey } }
          : {}),
      },
    };
    return this.previewMutation(
      `Create story: ${input.summary}`,
      "POST",
      "/rest/api/2/issue",
      body,
    );
  }

  async createStory(
    input: CreateStoryInput,
    confirmer: Confirmer,
  ): Promise<{ executed: false } | { executed: true; result: { key: string } }> {
    const preview = this.createStoryPreview(input);
    return this.confirmAndExecute(preview, confirmer, () =>
      this.requestJson<{ key: string }>(preview.method, preview.path, preview.body),
    );
  }

  linkIssuesPreview(input: LinkIssuesInput): MutationPreview {
    const body = {
      type: { name: input.linkType ?? "Relates" },
      inwardIssue: { key: input.inwardKey },
      outwardIssue: { key: input.outwardKey },
    };
    return this.previewMutation(
      `Link ${input.inwardKey} ↔ ${input.outwardKey}`,
      "POST",
      "/rest/api/2/issueLink",
      body,
    );
  }

  async linkIssues(
    input: LinkIssuesInput,
    confirmer: Confirmer,
  ): Promise<{ executed: false } | { executed: true; result: void }> {
    const preview = this.linkIssuesPreview(input);
    return this.confirmAndExecute(preview, confirmer, () =>
      this.requestJson<void>(preview.method, preview.path, preview.body),
    );
  }

  setFixVersionPreview(input: SetFixVersionInput): MutationPreview {
    const body = {
      fields: {
        fixVersions: [{ name: input.fixVersion }],
      },
    };
    return this.previewMutation(
      `Set Fix Version ${input.fixVersion} on ${input.issueKey}`,
      "PUT",
      `/rest/api/2/issue/${encodeURIComponent(input.issueKey)}`,
      body,
    );
  }

  async setFixVersion(
    input: SetFixVersionInput,
    confirmer: Confirmer,
  ): Promise<{ executed: false } | { executed: true; result: void }> {
    const preview = this.setFixVersionPreview(input);
    return this.confirmAndExecute(preview, confirmer, () =>
      this.requestJson<void>(preview.method, preview.path, preview.body),
    );
  }

  setArchitectEstimatePreview(input: SetArchitectEstimateInput): MutationPreview {
    const fieldId =
      this.config.architectEstimateFieldId ?? "customfield_architect_estimate";
    const body = {
      fields: {
        [fieldId]: input.estimate,
      },
    };
    return this.previewMutation(
      `Set architect estimate on ${input.issueKey}`,
      "PUT",
      `/rest/api/2/issue/${encodeURIComponent(input.issueKey)}`,
      body,
    );
  }

  async setArchitectEstimate(
    input: SetArchitectEstimateInput,
    confirmer: Confirmer,
  ): Promise<{ executed: false } | { executed: true; result: void }> {
    const preview = this.setArchitectEstimatePreview(input);
    return this.confirmAndExecute(preview, confirmer, () =>
      this.requestJson<void>(preview.method, preview.path, preview.body),
    );
  }

  attachDecisionLinkPreview(input: AttachDecisionLinkInput): MutationPreview {
    const rev = input.revision ? `?at=${encodeURIComponent(input.revision)}` : "";
    const link =
      input.permalink ??
      (input.repositoryBrowseBase
        ? `${input.repositoryBrowseBase.replace(/\/$/, "")}/${input.decisionPath.replace(/^\//, "")}${rev}`
        : null);
    const comment = link
      ? `Architecture decision (pinned revision): ${link}`
      : `Architecture decision: ${input.decisionPath}${input.revision ? `@${input.revision}` : ""} — WARNING: no permalink; pass permalink or repositoryBrowseBase`;
    const body = { body: comment };
    return this.previewMutation(
      `Attach decision link on ${input.issueKey}`,
      "POST",
      `/rest/api/2/issue/${encodeURIComponent(input.issueKey)}/comment`,
      body,
    );
  }

  async attachDecisionLink(
    input: AttachDecisionLinkInput,
    confirmer: Confirmer,
  ): Promise<{ executed: false } | { executed: true; result: { id: string } }> {
    const preview = this.attachDecisionLinkPreview(input);
    return this.confirmAndExecute(preview, confirmer, () =>
      this.requestJson<{ id: string }>(preview.method, preview.path, preview.body),
    );
  }

  /**
   * Atomic human gate for a package of mutations (WBS 3.8).
   * On reject: no writes. On approve: run executors in order.
   */
  async confirmAndExecutePackage<T>(
    summary: string,
    mutations: MutationPreview[],
    confirmer: import("./types.js").PackageConfirmer,
    executors: Array<() => Promise<T>>,
  ): Promise<{ executed: false } | { executed: true; results: T[] }> {
    if (mutations.length !== executors.length) {
      throw new Error("mutations and executors length mismatch");
    }
    const preview = {
      id: nextPreviewId(),
      summary,
      mutations,
    };
    const approved = await confirmer(preview);
    if (!approved) return { executed: false };
    const results: T[] = [];
    for (const ex of executors) {
      results.push(await ex());
    }
    return { executed: true, results };
  }

  async readFeatureStatuses(featureKey: string): Promise<{
    key: string;
    status: string;
    linked: { key: string; status: string; type: string }[];
  }> {
    const issue = await this.requestJson<{
      key: string;
      fields: {
        status: { name: string };
        issuelinks?: {
          type: { name: string };
          inwardIssue?: { key: string; fields: { status: { name: string } } };
          outwardIssue?: { key: string; fields: { status: { name: string } } };
        }[];
      };
    }>(
      "GET",
      `/rest/api/2/issue/${encodeURIComponent(featureKey)}?fields=status,issuelinks`,
    );

    const linked: { key: string; status: string; type: string }[] = [];
    for (const link of issue.fields.issuelinks ?? []) {
      const other = link.inwardIssue ?? link.outwardIssue;
      if (!other) continue;
      linked.push({
        key: other.key,
        status: other.fields.status.name,
        type: link.type.name,
      });
    }

    return {
      key: issue.key,
      status: issue.fields.status.name,
      linked,
    };
  }

  /** Read-only issue fetch for smoke / verification. */
  async getIssue(
    issueKey: string,
    fields = "summary,status",
  ): Promise<{
    key: string;
    fields: { summary?: string; status?: { name: string } };
  }> {
    return this.requestJson(
      "GET",
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}`,
    );
  }
}

export {
  createJiraProvider,
  RestJiraProvider,
  createMockFetch,
  createMockJiraState,
  DEFAULT_MOCK_TRANSITIONS,
  LOCALIZED_RU_TRANSITIONS,
} from "./rest-provider.js";
export {
  JiraTransitionError,
  parseJiraTransitions,
  parseNumericTransitionId,
  assertNumericTransitionId,
  resolveSemanticTransition,
  planSemanticIssueTransition,
  applySemanticIssueTransition,
} from "./transitions.js";
export { parseJiraSuccessBody, readJiraResponseJson, isAbortError } from "./http.js";
export {
  buildIssueTypeMapping,
  resolveSemanticType,
} from "./issue-types.js";
export { detectJiraMode } from "./config.js";
export type { JiraProvider } from "./provider.js";
