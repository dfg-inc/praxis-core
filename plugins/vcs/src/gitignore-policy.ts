import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const RECOMMENDED_GITIGNORE = [
  ".praxis-jira/",
  ".praxis-quality/",
  ".praxis-git/",
  ".praxis-local-tgz/",
  "*.sqlite",
  "*.pid",
];

export type GitignorePreview = {
  path: string;
  exists: boolean;
  current: string;
  missingLines: string[];
  proposed: string | null;
  writes: false;
};

export function previewGitignore(repo: string): GitignorePreview {
  const path = join(repo, ".gitignore");
  const exists = existsSync(path);
  const current = exists ? readFileSync(path, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const missingLines = RECOMMENDED_GITIGNORE.filter((rule) => !lines.some((l) => l.trim() === rule));
  let proposed: string | null = null;
  if (missingLines.length) {
    const extra = missingLines.join("\n");
    proposed = current.endsWith("\n") || current === "" ? `${current}${extra}\n` : `${current}\n${extra}\n`;
  }
  return { path: ".gitignore", exists, current, missingLines, proposed, writes: false };
}
