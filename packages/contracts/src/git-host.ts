import { z } from "zod";

export const GitHostProviderSchema = z.enum(["gitlab", "github"]);
export type GitHostProvider = z.infer<typeof GitHostProviderSchema>;

export const CreateMergeRequestRequestSchema = z.object({
  contract: z.literal("developer.merge-request.remote-preview"),
  version: z.literal("0.1.0"),
  provider: GitHostProviderSchema,
  method: z.literal("POST"),
  url: z.string().url(),
  headers: z.record(z.string()),
  body: z.record(z.unknown()),
  dryRun: z.literal(true),
  wouldWrite: z.literal(false),
  missingCredentials: z.boolean(),
  blockedReason: z.string().optional(),
});
export type CreateMergeRequestRequest = z.infer<
  typeof CreateMergeRequestRequestSchema
>;

export const CiProviderPreviewSchema = z.object({
  contract: z.literal("quality.ci.provider-preview"),
  version: z.literal("0.1.0"),
  provider: GitHostProviderSchema,
  method: z.literal("GET"),
  url: z.string().url(),
  dryRun: z.literal(true),
  wouldWrite: z.literal(false),
  missingCredentials: z.boolean(),
  blockedReason: z.string().optional(),
});
export type CiProviderPreview = z.infer<typeof CiProviderPreviewSchema>;

export function validateGitHostConfig(input: {
  provider?: string;
  baseUrl?: string;
  token?: string;
  projectPath?: string;
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!input.provider) errors.push("missing provider (gitlab|github)");
  else if (input.provider !== "gitlab" && input.provider !== "github") {
    errors.push(`unknown provider ${input.provider}`);
  }
  if (!input.baseUrl) errors.push("missing baseUrl");
  else {
    try {
      const u = new URL(input.baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        errors.push("baseUrl must be http(s)");
      }
    } catch {
      errors.push(`malformed baseUrl ${input.baseUrl}`);
    }
  }
  if (!input.projectPath) errors.push("missing projectPath");
  return { ok: errors.length === 0, errors };
}

function tokenHeader(provider: GitHostProvider, token?: string) {
  if (!token) return {};
  if (provider === "gitlab") return { "PRIVATE-TOKEN": token };
  return { Authorization: `Bearer ${token}` };
}

export function buildCreateMergeRequestRequest(input: {
  provider: GitHostProvider;
  baseUrl: string;
  token?: string;
  projectPath: string;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
}): CreateMergeRequestRequest {
  const cfg = validateGitHostConfig(input);
  const base = input.baseUrl.replace(/\/$/, "");
  const encoded = encodeURIComponent(input.projectPath);
  const url =
    input.provider === "gitlab"
      ? `${base}/api/v4/projects/${encoded}/merge_requests`
      : `${base}/repos/${input.projectPath}/pulls`;
  const body =
    input.provider === "gitlab"
      ? {
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
          title: input.title,
          description: input.description,
        }
      : {
          title: input.title,
          body: input.description,
          head: input.sourceBranch,
          base: input.targetBranch,
        };
  const missingCredentials = !input.token;
  return CreateMergeRequestRequestSchema.parse({
    contract: "developer.merge-request.remote-preview",
    version: "0.1.0",
    provider: input.provider,
    method: "POST",
    url,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...tokenHeader(input.provider, input.token),
    },
    body,
    dryRun: true,
    wouldWrite: false,
    missingCredentials,
    blockedReason: !cfg.ok
      ? cfg.errors.join("; ")
      : missingCredentials
        ? "missing credential — remote write not attempted"
        : "dry-run: remote write not attempted",
  });
}

export function buildCiContextRequest(input: {
  provider: GitHostProvider;
  baseUrl: string;
  token?: string;
  projectPath: string;
  mergeRequestIid?: string;
  sha?: string;
}): CiProviderPreview {
  const cfg = validateGitHostConfig(input);
  const base = input.baseUrl.replace(/\/$/, "");
  const url =
    input.provider === "gitlab"
      ? `${base}/api/v4/projects/${encodeURIComponent(input.projectPath)}/merge_requests/${input.mergeRequestIid ?? "0"}`
      : `${base}/repos/${input.projectPath}/commits/${input.sha ?? "HEAD"}/status`;
  const missingCredentials = !input.token;
  return CiProviderPreviewSchema.parse({
    contract: "quality.ci.provider-preview",
    version: "0.1.0",
    provider: input.provider,
    method: "GET",
    url,
    dryRun: true,
    wouldWrite: false,
    missingCredentials,
    blockedReason: !cfg.ok
      ? cfg.errors.join("; ")
      : missingCredentials
        ? "missing credential — live CI/MR provider not queried"
        : "dry-run: live CI/MR provider not queried",
  });
}

/** WBS 6.2.2 — pipeline step when Quality is down: do not mark the MR. */
export function qualityServiceUnavailableStep(): {
  step: "quality-review";
  status: "failed";
  postedToMergeRequest: false;
  reason: string;
} {
  return {
    step: "quality-review",
    status: "failed",
    postedToMergeRequest: false,
    reason: "quality-service unavailable; merge request left unmarked",
  };
}
