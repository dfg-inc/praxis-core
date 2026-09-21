const TOKEN_RE =
  /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_\-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}/g;

export function redactSecrets(text: string): string {
  return text
    .replace(TOKEN_RE, "<redacted>")
    .replace(/PRAXIS_GITHUB_TOKEN=\S+/g, "PRAXIS_GITHUB_TOKEN=<redacted>")
    .replace(/PRAXIS_GITLAB_TOKEN=\S+/g, "PRAXIS_GITLAB_TOKEN=<redacted>")
    .replace(/Authorization:\s*\S+/gi, "Authorization=<redacted>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\/\/([^/@\s]+):([^@/\s]+)@/g, "//$1:<redacted>@")
    .replace(/x-access-token:[^@\s]+@/gi, "x-access-token:<redacted>@");
}

export function tokenConfigured(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}
