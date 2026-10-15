import { requireMutationLease } from "@praxis/contracts";
import { VCS_CODES, VcsError } from "./errors.js";
import { tokenConfigured } from "./redact.js";
import type { CiStatus, MergeRequestInfo, RemoteRepositoryInfo, VcsProvider } from "./provider.js";

export type GitlabConfig = {
  token: string;
  baseUrl: string;
};

export function loadGitlabConfig(env: NodeJS.ProcessEnv = process.env): GitlabConfig {
  const token = env.PRAXIS_GITLAB_TOKEN?.trim() ?? "";
  if (!tokenConfigured(token)) {
    throw new VcsError(
      VCS_CODES.GITLAB_TOKEN_UNAVAILABLE,
      "GITLAB_TOKEN_UNAVAILABLE: configure gitlab_token in Praxis Runtime settings or PRAXIS_GITLAB_TOKEN for CLI/CI. Do not paste the token into chat. This is a GitLab PAT, not OAuth.",
    );
  }
  return {
    token,
    baseUrl: (env.PRAXIS_GITLAB_BASE_URL?.trim() || "https://gitlab.com").replace(/\/$/, ""),
  };
}

export function gitlabTokenFlags(env: NodeJS.ProcessEnv = process.env): {
  tokenConfigured: boolean;
  baseUrlConfigured: boolean;
} {
  return {
    tokenConfigured: tokenConfigured(env.PRAXIS_GITLAB_TOKEN),
    baseUrlConfigured: Boolean(env.PRAXIS_GITLAB_BASE_URL?.trim()),
  };
}

type FetchLike = typeof fetch;

export function createGitlabProvider(opts?: {
  config?: GitlabConfig;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}): VcsProvider {
  const config =
    opts?.config ??
    (opts?.fetchImpl
      ? {
          token: opts.env?.PRAXIS_GITLAB_TOKEN?.trim() || "fetch-impl",
          baseUrl: (opts.env?.PRAXIS_GITLAB_BASE_URL?.trim() || "https://gitlab.com").replace(/\/$/, ""),
        }
      : loadGitlabConfig(opts?.env));
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const apiRoot = `${config.baseUrl}/api/v4`;

  async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | undefined }> {
    const res = await fetchImpl(`${apiRoot}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "PRIVATE-TOKEN": config.token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: T | undefined;
    if (text.trim()) {
      try {
        json = JSON.parse(text) as T;
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, json };
  }

  function projectId(identity: { projectPath?: string; owner?: string; repo?: string }): string {
    const path = identity.projectPath || [identity.owner, identity.repo].filter(Boolean).join("/");
    if (!path) throw new VcsError(VCS_CODES.GIT_PROVIDER_UNKNOWN, "GitLab project path is required");
    return encodeURIComponent(path);
  }

  return {
    kind: "gitlab",
    async inspectRepository(identity) {
      const id = projectId(identity);
      const res = await api<Record<string, unknown>>("GET", `/projects/${id}`);
      if (res.status >= 400 || !res.json) {
        throw new VcsError(VCS_CODES.GIT_TRANSPORT_FAILED, `GitLab project lookup failed HTTP ${res.status}`);
      }
      const json = res.json;
      const empty = json.empty_repo === true;
      const info: RemoteRepositoryInfo = {
        provider: "gitlab",
        identity: String(json.path_with_namespace ?? identity.projectPath ?? ""),
        owner: identity.owner,
        repo: identity.repo,
        defaultBranch: typeof json.default_branch === "string" ? json.default_branch : null,
        empty,
        hasReadme: Boolean(json.readme_url),
        htmlUrl: typeof json.web_url === "string" ? json.web_url : undefined,
      };
      return info;
    },
    async listOpenMergeRequests(opts) {
      const id = projectId(opts);
      const res = await api<Array<Record<string, unknown>>>(
        "GET",
        `/projects/${id}/merge_requests?state=opened&source_branch=${encodeURIComponent(opts.sourceBranch)}`,
      );
      const items = Array.isArray(res.json) ? res.json : [];
      return items.map(mapMr);
    },
    async createMergeRequest(opts) {
      requireMutationLease();
      const existing = await this.listOpenMergeRequests(opts);
      if (existing[0]) return existing[0];
      const id = projectId(opts);
      const res = await api<Record<string, unknown>>("POST", `/projects/${id}/merge_requests`, {
        source_branch: opts.sourceBranch,
        target_branch: opts.targetBranch,
        title: opts.title,
        description: opts.body,
      });
      if (res.status >= 400 || !res.json) {
        throw new VcsError(VCS_CODES.GIT_TRANSPORT_FAILED, `GitLab merge request failed HTTP ${res.status}`);
      }
      return mapMr(res.json);
    },
    async pipelineStatus(opts) {
      const id = projectId(opts);
      const res = await api<Array<Record<string, unknown>>>(
        "GET",
        `/projects/${id}/pipelines?ref=${encodeURIComponent(opts.branch)}&per_page=1`,
      );
      const pipe = Array.isArray(res.json) ? res.json[0] : undefined;
      if (!pipe) return { ciStatus: "not_started" as CiStatus };
      const status = String(pipe.status ?? "");
      if (status === "success") return { ciStatus: "success" };
      if (status === "failed") return { ciStatus: "failure" };
      if (status === "canceled" || status === "cancelled") return { ciStatus: "cancelled" };
      if (status === "pending" || status === "created" || status === "waiting_for_resource") {
        return { ciStatus: "queued" };
      }
      if (status === "running") return { ciStatus: "in_progress" };
      return { ciStatus: "unknown" };
    },
  };
}

function mapMr(p: Record<string, unknown>): MergeRequestInfo {
  return {
    kind: "merge-request",
    id: Number(p.id ?? p.iid ?? 0),
    iid: Number(p.iid ?? 0),
    url: String(p.web_url ?? ""),
    sourceBranch: String(p.source_branch ?? ""),
    targetBranch: String(p.target_branch ?? ""),
    title: String(p.title ?? ""),
    state: String(p.state ?? "opened"),
    merged: p.state === "merged",
  };
}
