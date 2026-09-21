import { runGit } from "./git-local.js";
import { VCS_CODES, VcsError } from "./errors.js";

const SECRET_GREP =
  "github_pat_|ghp_[A-Za-z0-9]|gho_|glpat-|ATATT3|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH )?PRIVATE KEY";

export type SecretScanHit = { path: string };

export function scanRevisionForSecrets(repo: string, rev: string): SecretScanHit[] {
  const files = runGit(repo, ["grep", "-I", "-l", "-E", SECRET_GREP, rev]);
  const hits: SecretScanHit[] = [];
  if (files.status === 0) {
    for (const line of files.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const path = trimmed.includes(":") ? trimmed.slice(trimmed.indexOf(":") + 1) : trimmed;
      hits.push({ path });
    }
  }
  const log = runGit(repo, ["log", "--format=%H %s", rev]);
  if (log.status === 0 && new RegExp(SECRET_GREP).test(log.stdout)) {
    hits.push({ path: "(commit message)" });
  }
  return hits;
}

export function requireCleanSecretScan(repo: string, rev: string): void {
  const hits = scanRevisionForSecrets(repo, rev);
  if (!hits.length) return;
  const paths = [...new Set(hits.map((h) => h.path))];
  throw new VcsError(
    VCS_CODES.GIT_SECRETS_DETECTED,
    `GIT_SECRETS_DETECTED: ${paths.length} path(s) in ${rev} look like credentials. Baseline/feature publish is blocked. Values are not shown.`,
    { paths, rev },
  );
}
