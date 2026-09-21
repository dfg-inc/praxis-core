export type MergeRequestKind = "pull-request" | "merge-request";

export type CiStatus =
  | "unknown"
  | "not_configured"
  | "not_started"
  | "queued"
  | "in_progress"
  | "success"
  | "failure"
  | "cancelled";

export type RemoteRepositoryInfo = {
  provider: "github" | "gitlab";
  identity: string;
  owner?: string;
  repo?: string;
  defaultBranch: string | null;
  empty: boolean;
  hasReadme: boolean;
  htmlUrl?: string;
  apiUrl?: string;
};

export type MergeRequestInfo = {
  kind: MergeRequestKind;
  id: string | number;
  iid?: number;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  state: string;
  merged: boolean;
};

export type VcsProvider = {
  kind: "github" | "gitlab";
  inspectRepository(identity: {
    owner?: string;
    repo?: string;
    projectPath?: string;
    host: string;
  }): Promise<RemoteRepositoryInfo>;
  listOpenMergeRequests(opts: {
    owner?: string;
    repo?: string;
    projectPath?: string;
    sourceBranch: string;
    targetBranch?: string;
  }): Promise<MergeRequestInfo[]>;
  createMergeRequest(opts: {
    owner?: string;
    repo?: string;
    projectPath?: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    body: string;
    commitSha?: string;
  }): Promise<MergeRequestInfo>;
  pipelineStatus(opts: {
    owner?: string;
    repo?: string;
    projectPath?: string;
    branch: string;
    commitSha?: string;
  }): Promise<{ ciStatus: CiStatus; details?: string }>;
};
