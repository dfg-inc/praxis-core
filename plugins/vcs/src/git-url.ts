import { redactSecrets } from "./redact.js";

export type GitProtocol = "ssh" | "https" | "file" | "other";

export type VcsProviderKind = "github" | "gitlab" | "unknown";

export type ParsedRemote = {
  raw: string;
  displayUrl: string;
  identity: string;
  protocol: GitProtocol;
  host: string;
  owner?: string;
  repo?: string;
  projectPath?: string;
  inferredProvider: VcsProviderKind;
};

export function redactRemoteUrl(url: string): string {
  return redactSecrets(url.trim());
}

export function remoteIdentity(url: string): string {
  const parsed = parseRemoteUrl(url);
  return parsed.identity;
}

export function parseRemoteUrl(raw: string): ParsedRemote {
  const url = raw.trim();
  const displayUrl = redactRemoteUrl(url);
  const sshScp = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/i);
  if (sshScp) {
    const host = sshScp[1]!.toLowerCase();
    const projectPath = sshScp[2]!.replace(/\.git$/i, "");
    const { owner, repo } = splitOwnerRepo(projectPath);
    return {
      raw: url,
      displayUrl,
      identity: `${host}/${projectPath}`,
      protocol: "ssh",
      host,
      owner,
      repo,
      projectPath,
      inferredProvider: inferProvider(host),
    };
  }
  const sshUri = url.match(/^ssh:\/\/(?:git@)?([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshUri) {
    const host = sshUri[1]!.toLowerCase();
    const projectPath = sshUri[2]!.replace(/\.git$/i, "");
    const { owner, repo } = splitOwnerRepo(projectPath);
    return {
      raw: url,
      displayUrl,
      identity: `${host}/${projectPath}`,
      protocol: "ssh",
      host,
      owner,
      repo,
      projectPath,
      inferredProvider: inferProvider(host),
    };
  }
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    const host = u.hostname.toLowerCase();
    const protocol: GitProtocol =
      u.protocol === "https:" || u.protocol === "http:"
        ? "https"
        : u.protocol === "file:"
          ? "file"
          : "other";
    const projectPath = u.pathname.replace(/^\//, "").replace(/\.git$/i, "");
    const { owner, repo } = splitOwnerRepo(projectPath);
    return {
      raw: url,
      displayUrl,
      identity: `${host}/${projectPath}`,
      protocol,
      host,
      owner,
      repo,
      projectPath,
      inferredProvider: inferProvider(host),
    };
  } catch {
    return {
      raw: url,
      displayUrl,
      identity: displayUrl,
      protocol: "other",
      host: "",
      inferredProvider: "unknown",
    };
  }
}

function splitOwnerRepo(projectPath: string): { owner?: string; repo?: string } {
  const parts = projectPath.split("/").filter(Boolean);
  if (parts.length < 2) return {};
  return { owner: parts[0], repo: parts[parts.length - 1] };
}

export function inferProvider(host: string): VcsProviderKind {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com") || h === "api.github.com") return "github";
  if (h === "gitlab.com" || h.endsWith(".gitlab.com")) return "gitlab";
  if (h.includes("gitlab")) return "gitlab";
  if (h.includes("github")) return "github";
  return "unknown";
}

export function resolveProvider(opts: {
  inferred: VcsProviderKind;
  configured?: string;
}): VcsProviderKind {
  const configured = (opts.configured ?? "").trim().toLowerCase();
  if (configured === "github" || configured === "gitlab") return configured;
  return opts.inferred;
}
