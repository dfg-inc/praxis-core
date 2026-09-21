import type { CiStatus, MergeRequestInfo, RemoteRepositoryInfo, VcsProvider } from "./provider.js";

export type MockGithubState = {
  owner: string;
  repo: string;
  defaultBranch: string | null;
  empty: boolean;
  hasReadme: boolean;
  pulls: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  htmlUrl: string;
};

export function createMockGithubState(partial?: Partial<MockGithubState>): MockGithubState {
  return {
    owner: "hisagedru",
    repo: "praxis-acceptance-test",
    defaultBranch: partial?.empty === false ? "main" : null,
    empty: true,
    hasReadme: false,
    pulls: [],
    runs: [],
    htmlUrl: "https://github.com/hisagedru/praxis-acceptance-test",
    ...partial,
  };
}

export function createMockGithubFetch(state: MockGithubState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/user") && method === "GET" && !url.includes("/repos")) {
      return json(200, { login: state.owner });
    }
    const pullsMatch = url.match(/\/repos\/([^/]+)\/([^/]+)\/pulls/);
    if (pullsMatch && method === "GET") {
      const head = new URL(url).searchParams.get("head") ?? "";
      const branch = head.includes(":") ? head.split(":")[1] : head;
      const open = state.pulls.filter(
        (p) => p.state === "open" && String((p.head as { ref?: string })?.ref ?? "") === branch,
      );
      return json(200, open);
    }
    if (pullsMatch && method === "POST") {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const existing = state.pulls.find(
        (p) => p.state === "open" && String((p.head as { ref?: string })?.ref) === body.head,
      );
      if (existing) return json(422, { errors: [{ message: "A pull request already exists" }] });
      const pr = {
        number: state.pulls.length + 1,
        id: state.pulls.length + 1,
        html_url: `${state.htmlUrl}/pull/${state.pulls.length + 1}`,
        title: body.title,
        state: "open",
        merged: false,
        head: { ref: body.head },
        base: { ref: body.base },
      };
      state.pulls.push(pr);
      return json(201, pr);
    }
    if (url.includes("/actions/runs")) {
      return json(200, { workflow_runs: state.runs });
    }
    if (url.includes("/commits")) {
      if (state.empty) return json(409, { message: "Git Repository is empty." });
      return json(200, [{ sha: "abc" }]);
    }
    if (url.includes("/readme")) {
      return state.hasReadme ? json(200, { name: "README.md" }) : json(404, { message: "Not Found" });
    }
    const repoMatch = url.match(/\/repos\/([^/]+)\/([^/?]+)$/);
    if (repoMatch && method === "GET") {
      return json(200, {
        default_branch: state.defaultBranch,
        size: state.empty ? 0 : 12,
        html_url: state.htmlUrl,
        empty: state.empty,
      });
    }
    return json(404, { message: "not mocked" });
  }) as typeof fetch;
}

export type MockGitlabState = {
  pathWithNamespace: string;
  empty: boolean;
  defaultBranch: string | null;
  mrs: Array<Record<string, unknown>>;
  pipelines: Array<Record<string, unknown>>;
  webUrl: string;
};

export function createMockGitlabState(partial?: Partial<MockGitlabState>): MockGitlabState {
  return {
    pathWithNamespace: "group/project",
    empty: false,
    defaultBranch: "main",
    mrs: [],
    pipelines: [],
    webUrl: "https://gitlab.example.com/group/project",
    ...partial,
  };
}

export function createMockGitlabFetch(state: MockGitlabState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/merge_requests") && method === "GET") {
      return json(200, state.mrs.filter((m) => m.state === "opened"));
    }
    if (url.includes("/merge_requests") && method === "POST") {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const existing = state.mrs.find(
        (m) => m.state === "opened" && m.source_branch === body.source_branch,
      );
      if (existing) return json(409, { message: "exists" });
      const mr = {
        id: state.mrs.length + 1,
        iid: state.mrs.length + 1,
        web_url: `${state.webUrl}/-/merge_requests/${state.mrs.length + 1}`,
        source_branch: body.source_branch,
        target_branch: body.target_branch,
        title: body.title,
        state: "opened",
      };
      state.mrs.push(mr);
      return json(201, mr);
    }
    if (url.includes("/pipelines")) {
      return json(200, state.pipelines);
    }
    if (url.includes("/projects/")) {
      return json(200, {
        path_with_namespace: state.pathWithNamespace,
        default_branch: state.defaultBranch,
        empty_repo: state.empty,
        readme_url: state.empty ? null : `${state.webUrl}/-/blob/README.md`,
        web_url: state.webUrl,
      });
    }
    return json(404, {});
  }) as typeof fetch;
}

export type { CiStatus, MergeRequestInfo, RemoteRepositoryInfo, VcsProvider };
