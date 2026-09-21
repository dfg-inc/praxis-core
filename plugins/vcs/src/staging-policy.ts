export const SENSITIVE_PREFIXES = [
  ".praxis-jira/",
  ".praxis-quality/",
  ".praxis-git/",
  ".praxis-local-tgz/",
];

export const SENSITIVE_NAMES = new Set([".npmrc"]);

export const SENSITIVE_SUFFIXES = [".sqlite", ".pid", ".log"];

export const OPT_IN_PREFIXES = [
  "design/",
  "work-packages/",
  "wp/",
  "architecture/",
  ".ba/",
];

export const OPT_IN_NAMES = new Set([".project"]);

export type StagingDecision = {
  path: string;
  allowed: boolean;
  reason:
    | "allowlist"
    | "sensitive"
    | "opt-in-required"
    | "unknown-untracked"
    | "outside-allowlist";
};

export function classifyPath(rel: string): StagingDecision["reason"] | "ok" {
  const n = rel.replace(/^\.\//, "");
  if (SENSITIVE_NAMES.has(n) || SENSITIVE_PREFIXES.some((p) => n === p.slice(0, -1) || n.startsWith(p))) {
    return "sensitive";
  }
  if (SENSITIVE_SUFFIXES.some((s) => n.endsWith(s))) return "sensitive";
  if (OPT_IN_NAMES.has(n) || OPT_IN_PREFIXES.some((p) => n === p.slice(0, -1) || n.startsWith(p))) {
    return "opt-in-required";
  }
  return "ok";
}

export function planStaging(opts: {
  allowlist: string[];
  staged: string[];
  unstaged: string[];
  untracked: string[];
}): {
  selected: string[];
  rejected: StagingDecision[];
  foreignStaged: string[];
} {
  const allow = new Set(opts.allowlist.map((p) => p.replace(/^\.\//, "")));
  const selected: string[] = [];
  const rejected: StagingDecision[] = [];
  for (const path of opts.allowlist) {
    const n = path.replace(/^\.\//, "");
    const kind = classifyPath(n);
    if (kind === "sensitive") {
      rejected.push({ path: n, allowed: false, reason: "sensitive" });
      continue;
    }
    selected.push(n);
  }
  const foreignStaged = opts.staged.filter((p) => !allow.has(p.replace(/^\.\//, "")));
  for (const path of [...opts.unstaged, ...opts.untracked]) {
    const n = path.replace(/^\.\//, "");
    if (allow.has(n)) continue;
    const kind = classifyPath(n);
    if (kind === "sensitive") rejected.push({ path: n, allowed: false, reason: "sensitive" });
    else if (kind === "opt-in-required") rejected.push({ path: n, allowed: false, reason: "opt-in-required" });
    else rejected.push({ path: n, allowed: false, reason: "unknown-untracked" });
  }
  return { selected, rejected, foreignStaged };
}

export function defaultAllowlist(snapshotFiles?: string[]): string[] {
  if (snapshotFiles && snapshotFiles.length) return [...snapshotFiles];
  return [];
}
