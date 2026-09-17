import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const WP_ID_RE = /^WP-\d{8}-\d+$/;

export type LocalWorkPackage = {
  id: string;
  designDir?: string;
  canonWpDir?: string;
  manifestDir: string;
  changeSpecPath?: string;
  handoffPath?: string;
  indexMd?: string;
  mermaid: string[];
};

function listDirs(abs: string): string[] {
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .map((n) => join(abs, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

function readIf(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function extractMermaid(text: string): string[] {
  const out: string[] = [];
  const re = /```mermaid\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!.trim());
  return out;
}

export function discoverLocalWorkPackages(repo: string): LocalWorkPackage[] {
  const byId = new Map<string, LocalWorkPackage>();
  const take = (abs: string, kind: "design" | "canon" | "manifest") => {
    const id = abs.split("/").pop() ?? "";
    if (!WP_ID_RE.test(id)) return;
    const cur = byId.get(id) ?? {
      id,
      manifestDir: join(repo, "work-packages", id),
      mermaid: [],
    };
    if (kind === "design") cur.designDir = abs;
    if (kind === "canon") cur.canonWpDir = abs;
    if (kind === "manifest") cur.manifestDir = abs;
    byId.set(id, cur);
  };
  for (const p of listDirs(join(repo, "design"))) take(p, "design");
  for (const p of listDirs(join(repo, "wp"))) take(p, "canon");
  for (const p of listDirs(join(repo, "work-packages"))) take(p, "manifest");

  for (const wp of byId.values()) {
    const root = wp.designDir ?? wp.canonWpDir ?? wp.manifestDir;
    const spec = join(root, "change-spec.json");
    const handoff = join(root, "architect-developer.handoff.json");
    wp.changeSpecPath = existsSync(spec) ? spec : undefined;
    wp.handoffPath = existsSync(handoff) ? handoff : undefined;
    wp.indexMd = readIf(join(root, "index.md"));
    const blob = [
      wp.indexMd ?? "",
      readIf(join(root, "decisions.md")) ?? "",
      readIf(join(root, "nfr-budgets.md")) ?? "",
      readIf(join(root, "contracts.md")) ?? "",
    ].join("\n");
    wp.mermaid = extractMermaid(blob);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveRemoteWpKey(repo: string, wpKey: string): string {
  const local = resolveLocalWorkPackage(repo, wpKey);
  if (!local) return wpKey;
  const m = readWpManifest(repo, local.id);
  const key = m?.jiraIssueKey;
  return typeof key === "string" && key.length > 0 ? key : wpKey;
}

export function resolveLocalWorkPackage(
  repo: string,
  idOrKey: string,
): LocalWorkPackage | undefined {
  const all = discoverLocalWorkPackages(repo);
  const byId = all.find((w) => w.id === idOrKey);
  if (byId) return byId;
  for (const w of all) {
    const manifestPath = join(w.manifestDir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        jiraIssueKey?: string;
        id?: string;
      };
      if (m.jiraIssueKey === idOrKey || m.id === idOrKey) return w;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export function writeWpManifest(
  repo: string,
  wp: { id: string; jiraIssueKey: string } & Record<string, unknown>,
): string {
  const dir = join(repo, "work-packages", wp.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  writeFileSync(path, `${JSON.stringify(wp, null, 2)}\n`);
  return path;
}

export function readWpManifest(
  repo: string,
  id: string,
): Record<string, unknown> | undefined {
  const path = join(repo, "work-packages", id, "manifest.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
