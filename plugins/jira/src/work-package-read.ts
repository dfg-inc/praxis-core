import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverLocalWorkPackages,
  resolveLocalWorkPackage,
  type LocalWorkPackage,
} from "./work-package-local.js";

export const INVALID_WP_TITLES = new Set(["", "---", "-", "work package", "untitled"]);

export type WpTitleSource =
  | "manifest"
  | "design.change-spec"
  | "design.index"
  | "derived.story"
  | "invalid";

export type WpLifecycle =
  | "draft"
  | "ready"
  | "materialized"
  | "historical"
  | "superseded"
  | "archived"
  | "invalid";

export type NormalizedWorkPackage = {
  id: string;
  title: string;
  titleSource: WpTitleSource;
  jiraSummary: string;
  lifecycle: WpLifecycle;
  materializable: boolean;
  phasesComplete: boolean;
  status?: string;
  jiraIssueKey?: string;
  epicKey?: string;
  canonicalStory?: string;
  local: LocalWorkPackage;
  frontmatter: Record<string, string>;
};

export class WorkPackageScopeError extends Error {
  readonly code:
    | "WORK_PACKAGE_NOT_FOUND"
    | "WORK_PACKAGE_OUT_OF_SCOPE"
    | "WORK_PACKAGE_SUPERSEDED"
    | "WORK_PACKAGE_INVALID_STATE"
    | "WORK_PACKAGE_TITLE_INVALID"
    | "WORK_PACKAGE_SCOPE_AMBIGUOUS";
  readonly candidates?: string[];
  constructor(
    code: WorkPackageScopeError["code"],
    message: string,
    candidates?: string[],
  ) {
    super(`${code}: ${message}`);
    this.name = "WorkPackageScopeError";
    this.code = code;
    this.candidates = candidates;
  }
}

export function splitFrontmatter(text: string): {
  frontmatter: string;
  body: string;
  hasFence: boolean;
} {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: "", body: text, hasFence: false };
  return { frontmatter: m[1] ?? "", body: m[2] ?? "", hasFence: true };
}

export function parseSimpleFrontmatter(yamlBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of yamlBody.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function isInvalidWpTitle(raw: unknown): boolean {
  if (typeof raw !== "string") return true;
  const t = raw.trim();
  if (!t) return true;
  if (INVALID_WP_TITLES.has(t.toLowerCase())) return true;
  if (t === "---") return true;
  return false;
}

function firstMarkdownHeading(md: string): string | undefined {
  const { body } = splitFrontmatter(md);
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (!h?.[1]) continue;
    const title = h[1].trim();
    if (!isInvalidWpTitle(title)) return title;
  }
  return undefined;
}

function readText(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

function readJson(path: string | undefined): Record<string, unknown> | undefined {
  const raw = readText(path);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "yes";
}

export function classifyWpLifecycle(opts: {
  status?: string;
  phasesComplete: boolean;
  jiraIssueKey?: string;
}): WpLifecycle {
  const status = (opts.status ?? "").trim().toLowerCase();
  if (["superseded", "duplicate"].includes(status)) return "superseded";
  if (["archived", "abandoned", "invalid"].includes(status)) return "archived";
  if (
    opts.phasesComplete ||
    ["completed", "complete", "historical", "done", "accepted"].includes(status)
  ) {
    return "historical";
  }
  const key = opts.jiraIssueKey?.trim();
  if (key && key !== "PLANNED") return "materialized";
  if (status === "draft") return "draft";
  return "ready";
}

export function isMaterializableLifecycle(lifecycle: WpLifecycle): boolean {
  return lifecycle === "ready" || lifecycle === "materialized";
}

export function resolveWorkPackageTitle(opts: {
  manifestTitle?: string;
  changeSpecTitle?: string;
  designHeading?: string;
  storySummary?: string;
}): { title: string; titleSource: WpTitleSource } {
  if (!isInvalidWpTitle(opts.manifestTitle)) {
    return { title: opts.manifestTitle!.trim(), titleSource: "manifest" };
  }
  if (!isInvalidWpTitle(opts.changeSpecTitle)) {
    return { title: opts.changeSpecTitle!.trim(), titleSource: "design.change-spec" };
  }
  if (!isInvalidWpTitle(opts.designHeading)) {
    return { title: opts.designHeading!.trim(), titleSource: "design.index" };
  }
  if (!isInvalidWpTitle(opts.storySummary)) {
    return { title: opts.storySummary!.trim(), titleSource: "derived.story" };
  }
  return { title: "", titleSource: "invalid" };
}

export function jiraWpSummary(id: string, title: string): string {
  return `[${id}] ${title}`;
}

export function readNormalizedWorkPackage(
  repo: string,
  local: LocalWorkPackage,
  opts?: { storySummary?: string },
): NormalizedWorkPackage {
  const designIndex = local.designDir
    ? readText(join(local.designDir, "index.md"))
    : undefined;
  const canonIndex = local.canonWpDir
    ? readText(join(local.canonWpDir, "index.md"))
    : readText(join(repo, "wp", local.id, "index.md"));
  const manifest = readJson(join(local.manifestDir, "manifest.json"));
  const specPath =
    local.changeSpecPath ??
    (local.designDir ? join(local.designDir, "change-spec.json") : undefined);
  const spec = readJson(specPath);
  const fm = {
    ...parseSimpleFrontmatter(splitFrontmatter(designIndex ?? "").frontmatter),
    ...parseSimpleFrontmatter(splitFrontmatter(canonIndex ?? "").frontmatter),
  };
  const design = spec?.design && typeof spec.design === "object"
    ? (spec.design as Record<string, unknown>)
    : {};
  const { title, titleSource } = resolveWorkPackageTitle({
    manifestTitle: fm.title,
    changeSpecTitle:
      typeof design.title === "string"
        ? design.title
        : typeof spec?.title === "string"
          ? spec.title
          : undefined,
    designHeading:
      firstMarkdownHeading(designIndex ?? "") ?? firstMarkdownHeading(canonIndex ?? ""),
    storySummary: opts?.storySummary,
  });
  const phasesComplete = truthy(fm.phasesComplete);
  const jiraIssueKey =
    typeof manifest?.jiraIssueKey === "string"
      ? manifest.jiraIssueKey
      : fm.jiraIssueKey;
  const lifecycle = classifyWpLifecycle({
    status: fm.status ?? (typeof manifest?.status === "string" ? manifest.status : undefined),
    phasesComplete,
    jiraIssueKey,
  });
  const epicKey =
    fm.epicKey ||
    (typeof manifest?.epicKey === "string" ? manifest.epicKey : undefined);
  return {
    id: local.id,
    title,
    titleSource,
    jiraSummary: title ? jiraWpSummary(local.id, title) : `[${local.id}] ---`,
    lifecycle,
    materializable: isMaterializableLifecycle(lifecycle),
    phasesComplete,
    status: fm.status,
    jiraIssueKey,
    epicKey,
    canonicalStory: fm.canonicalStory,
    local,
    frontmatter: fm,
  };
}

export function listNormalizedWorkPackages(
  repo: string,
  opts?: { storySummary?: string },
): NormalizedWorkPackage[] {
  return discoverLocalWorkPackages(repo).map((local) =>
    readNormalizedWorkPackage(repo, local, opts),
  );
}

export function selectArchitectWorkPackages(opts: {
  repo: string;
  epicKey: string;
  workPackageId?: string;
  storySummary?: string;
}): {
  selected: NormalizedWorkPackage[];
  inspected: NormalizedWorkPackage[];
} {
  const inspected = listNormalizedWorkPackages(opts.repo, {
    storySummary: opts.storySummary,
  });
  if (opts.workPackageId) {
    const hit =
      inspected.find((w) => w.id === opts.workPackageId) ??
      (() => {
        const local = resolveLocalWorkPackage(opts.repo, opts.workPackageId!);
        return local
          ? readNormalizedWorkPackage(opts.repo, local, {
              storySummary: opts.storySummary,
            })
          : undefined;
      })();
    if (!hit) {
      throw new WorkPackageScopeError(
        "WORK_PACKAGE_NOT_FOUND",
        `local work package not found: ${opts.workPackageId}`,
      );
    }
    if (hit.lifecycle === "superseded") {
      throw new WorkPackageScopeError(
        "WORK_PACKAGE_SUPERSEDED",
        `${hit.id} is superseded and cannot be materialized`,
      );
    }
    if (hit.lifecycle === "archived" || hit.lifecycle === "historical") {
      throw new WorkPackageScopeError(
        "WORK_PACKAGE_INVALID_STATE",
        `${hit.id} is ${hit.lifecycle} and is not currently materializable`,
      );
    }
    if (hit.epicKey && hit.epicKey !== opts.epicKey) {
      throw new WorkPackageScopeError(
        "WORK_PACKAGE_OUT_OF_SCOPE",
        `${hit.id} belongs to ${hit.epicKey}, not ${opts.epicKey}`,
      );
    }
    if (hit.titleSource === "invalid" || isInvalidWpTitle(hit.title)) {
      throw new WorkPackageScopeError(
        "WORK_PACKAGE_TITLE_INVALID",
        `${hit.id} has no valid title (refused ${JSON.stringify(hit.jiraSummary)})`,
      );
    }
    return { selected: [hit], inspected };
  }
  const materializable = inspected.filter((w) => w.materializable);
  if (materializable.length > 1) {
    throw new WorkPackageScopeError(
      "WORK_PACKAGE_SCOPE_AMBIGUOUS",
      "multiple materializable work packages; pass workPackageId to select one",
      materializable.map((w) => w.id),
    );
  }
  const selected = materializable[0];
  if (selected && (selected.titleSource === "invalid" || isInvalidWpTitle(selected.title))) {
    throw new WorkPackageScopeError(
      "WORK_PACKAGE_TITLE_INVALID",
      `${selected.id} has no valid title`,
    );
  }
  return { selected: selected ? [selected] : [], inspected };
}
