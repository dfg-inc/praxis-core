import { VCS_CODES, VcsError } from "./errors.js";
import { tokenConfigured } from "./redact.js";
import type { CiStatus, MergeRequestInfo, RemoteRepositoryInfo, VcsProvider } from "./provider.js";

export type GithubConfig = {
  token: string;
  apiUrl: string;
};

export type GithubApiUrlIssue = "git-ssh-remote" | "git-https-remote" | "invalid";

export type GithubApiUrlValidation = {
  ok: boolean;
  normalized: string;
  issue?: GithubApiUrlIssue;
  message?: string;
};

const DEFAULT_GITHUB_API = "https://api.github.com";

export function validateGithubApiUrl(raw: string | undefined): GithubApiUrlValidation {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: true, normalized: DEFAULT_GITHUB_API };
  }
  if (/^git@/i.test(trimmed) || /^ssh:\/\//i.test(trimmed)) {
    return {
      ok: false,
      normalized: DEFAULT_GITHUB_API,
      issue: "git-ssh-remote",
      message:
        "GITHUB_API_URL_INVALID: Git SSH remotes (git@host:owner/repo.git) are not GitHub API URLs. Use https://api.github.com, or https://HOST/api/v3 for GitHub Enterprise. Put the SSH URL in Connect Git, not github_api_url.",
    };
  }
  try {
    const u = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return {
        ok: false,
        normalized: DEFAULT_GITHUB_API,
        issue: "invalid",
        message:
          "GITHUB_API_URL_INVALID: GitHub API URL must be https://api.github.com (or https://HOST/api/v3 for GitHub Enterprise).",
      };
    }
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "") || "";
    if (/\.git$/i.test(path) || (host === "github.com" && /^\/[^/]+\/[^/]+$/.test(path))) {
      return {
        ok: false,
        normalized: DEFAULT_GITHUB_API,
        issue: "git-https-remote",
        message:
          "GITHUB_API_URL_INVALID: that value is a GitHub git remote, not the API. Use https://api.github.com.",
      };
    }
    const isDotComApi = host === "api.github.com" && (path === "" || path === "/");
    const isEnterprise = path === "/api/v3" || path.endsWith("/api/v3");
    if (!isDotComApi && !isEnterprise) {
      return {
        ok: false,
        normalized: DEFAULT_GITHUB_API,
        issue: "invalid",
        message:
          "GITHUB_API_URL_INVALID: GitHub API URL must be https://api.github.com (or https://HOST/api/v3 for GitHub Enterprise).",
      };
    }
    return { ok: true, normalized: `${u.protocol}//${u.host}${path}`.replace(/\/$/, "") || DEFAULT_GITHUB_API };
  } catch {
    return {
      ok: false,
      normalized: DEFAULT_GITHUB_API,
      issue: "invalid",
      message:
        "GITHUB_API_URL_INVALID: GitHub API URL must be https://api.github.com (or https://HOST/api/v3 for GitHub Enterprise).",
    };
  }
}

export function loadGithubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig {
  const token = env.PRAXIS_GITHUB_TOKEN?.trim() ?? "";
  if (!tokenConfigured(token)) {
    throw new VcsError(
      VCS_CODES.GITHUB_TOKEN_UNAVAILABLE,
      "GITHUB_TOKEN_UNAVAILABLE: configure github_token in Praxis Runtime settings or PRAXIS_GITHUB_TOKEN for CLI/CI. Do not paste the token into chat. This is a GitHub PAT, not OAuth.",
    );
  }
  const apiCheck = validateGithubApiUrl(env.PRAXIS_GITHUB_API_URL);
  if (!apiCheck.ok) {
    throw new VcsError(VCS_CODES.GITHUB_API_URL_INVALID, apiCheck.message ?? "GITHUB_API_URL_INVALID");
  }
  return {
    token,
    apiUrl: apiCheck.normalized,
  };
}

export function githubTokenFlags(env: NodeJS.ProcessEnv = process.env): {
  tokenConfigured: boolean;
  apiUrlConfigured: boolean;
  apiUrlValid: boolean;
  apiUrlIssue?: GithubApiUrlIssue;
} {
  const apiRaw = env.PRAXIS_GITHUB_API_URL?.trim() ?? "";
  const apiCheck = validateGithubApiUrl(apiRaw);
  return {
    tokenConfigured: tokenConfigured(env.PRAXIS_GITHUB_TOKEN),
    apiUrlConfigured: Boolean(apiRaw),
    apiUrlValid: apiCheck.ok,
    apiUrlIssue: apiCheck.ok ? undefined : apiCheck.issue,
  };
}

type FetchLike = typeof fetch;

export function createGithubProvider(opts?: {
  config?: GithubConfig;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}): VcsProvider {
  const config = opts?.config ?? loadGithubConfig(opts?.env);
  const fetchImpl = opts?.fetchImpl ?? fetch;

  async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | undefined; text: string }> {
    const res = await fetchImpl(`${config.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
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
    return { status: res.status, json, text };
  }

  function repoPath(identity: { owner?: string; repo?: string; projectPath?: string }): string {
    const owner = identity.owner ?? identity.projectPath?.split("/")[0];
    const repo = identity.repo ?? identity.projectPath?.split("/").pop();
    if (!owner || !repo) {
      throw new VcsError(VCS_CODES.GIT_PROVIDER_UNKNOWN, "GitHub repository owner/name is required");
    }
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  return {
    kind: "github",
    async inspectRepository(identity) {
      const path = repoPath(identity);
      const repoRes = await api<Record<string, unknown>>("GET", path);
      if (repoRes.status === 404) {
        throw new VcsError(VCS_CODES.GIT_TRANSPORT_FAILED, "GitHub repository not found or token lacks access");
      }
      if (repoRes.status >= 400) {
        throw new VcsError(VCS_CODES.GIT_TRANSPORT_FAILED, `GitHub API ${repoRes.status}`);
      }
      const json = repoRes.json ?? {};
      const commits = await api<unknown>("GET", `${path}/commits?per_page=1`);
      const empty = commits.status === 409 || commits.status === 404 || json.size === 0;
      const readme = await api<unknown>("GET", `${path}/readme`);
      const info: RemoteRepositoryInfo = {
        provider: "github",
        identity: `${identity.owner ?? ""}/${identity.repo ?? ""}`.replace(/^\//, ""),
        owner: identity.owner,
        repo: identity.repo,
        defaultBranch: typeof json.default_branch === "string" ? json.default_branch : empty ? null : "main",
        empty,
        hasReadme: readme.status === 200,
        htmlUrl: typeof json.html_url === "string" ? json.html_url : undefined,
        apiUrl: `${config.apiUrl}${path}`,
      };
      return info;
    },
    async listOpenMergeRequests(opts) {
      const path = repoPath(opts);
      const head = `${opts.owner}:${opts.sourceBranch}`;
      const res = await api<Array<Record<string, unknown>>>(
        "GET",
        `${path}/pulls?state=open&head=${encodeURIComponent(head)}`,
      );
      const items = Array.isArray(res.json) ? res.json : [];
      return items.map((p) => mapPr(p));
    },
    async createMergeRequest(opts) {
      const path = repoPath(opts);
      const existing = await this.listOpenMergeRequests(opts);
      if (existing[0]) return existing[0];
      const res = await api<Record<string, unknown>>("POST", `${path}/pulls`, {
        title: opts.title,
        head: opts.sourceBranch,
        base: opts.targetBranch,
        body: opts.body,
      });
      if (res.status === 422 && Array.isArray((res.json as { errors?: unknown[] } | undefined)?.errors)) {
        const again = await this.listOpenMergeRequests(opts);
        if (again[0]) return again[0];
      }
      if (res.status >= 400 || !res.json) {
        throw new VcsError(VCS_CODES.GIT_TRANSPORT_FAILED, `GitHub pull request failed HTTP ${res.status}`);
      }
      return mapPr(res.json);
    },
    async pipelineStatus(opts) {
      const path = repoPath(opts);
      const res = await api<{ workflow_runs?: Array<Record<string, unknown>> }>(
        "GET",
        `${path}/actions/runs?branch=${encodeURIComponent(opts.branch)}&per_page=1`,
      );
      const run = res.json?.workflow_runs?.[0];
      if (!run) return { ciStatus: "not_started" as CiStatus };
      const status = String(run.status ?? "");
      const conclusion = String(run.conclusion ?? "");
      if (status !== "completed") {
        if (status === "queued") return { ciStatus: "queued" };
        return { ciStatus: "in_progress" };
      }
      if (conclusion === "success") return { ciStatus: "success" };
      if (conclusion === "cancelled" || conclusion === "skipped") return { ciStatus: "cancelled" };
      if (conclusion === "failure" || conclusion === "timed_out") return { ciStatus: "failure" };
      return { ciStatus: "unknown" };
    },
  };
}

function mapPr(p: Record<string, unknown>): MergeRequestInfo {
  const head = p.head && typeof p.head === "object" ? (p.head as Record<string, unknown>) : {};
  const base = p.base && typeof p.base === "object" ? (p.base as Record<string, unknown>) : {};
  return {
    kind: "pull-request",
    id: Number(p.number ?? p.id ?? 0),
    iid: Number(p.number ?? 0),
    url: String(p.html_url ?? ""),
    sourceBranch: String(head.ref ?? ""),
    targetBranch: String(base.ref ?? ""),
    title: String(p.title ?? ""),
    state: String(p.state ?? "open"),
    merged: p.merged === true || p.merged_at != null,
  };
}
