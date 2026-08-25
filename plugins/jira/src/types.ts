export type MutationPreview = {
  id: string;
  summary: string;
  method: string;
  path: string;
  body?: unknown;
};

export type Confirmer = (preview: MutationPreview) => Promise<boolean> | boolean;

export type FetchLike = typeof fetch;

export type CreateFeatureInput = {
  summary: string;
  description?: string;
  issueType?: string;
};

export type CreateStoryInput = {
  summary: string;
  acceptanceCriteria: string;
  parentKey?: string;
  issueType?: string;
};

export type LinkIssuesInput = {
  inwardKey: string;
  outwardKey: string;
  linkType?: string;
};

export type SetFixVersionInput = {
  issueKey: string;
  fixVersion: string;
};

export type SetArchitectEstimateInput = {
  issueKey: string;
  estimate: string | number;
};

export type AttachDecisionLinkInput = {
  issueKey: string;
  decisionPath: string;
  revision?: string;
  /** Prefer a durable browse URL (blob/permalink). */
  permalink?: string;
  repositoryBrowseBase?: string;
};

export type MutationPackagePreview = {
  id: string;
  summary: string;
  mutations: MutationPreview[];
};

export type PackageConfirmer = (
  preview: MutationPackagePreview,
) => Promise<boolean> | boolean;
