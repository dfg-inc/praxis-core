/**
 * Shared SemVer release helpers for the Praxis monorepo.
 * Root package.json is the single source of truth for the release version.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** SemVer 2.0.0 including prerelease / build metadata. */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Internal monorepo deps must use a range that always matches the local
 * workspace package. npm does not support the `workspace:` protocol
 * (EUNSUPPORTEDPROTOCOL); `"*"` is the npm-workspaces convention so
 * `npm ci` links local `@praxis/*` packages and never hits the public registry.
 */
export const INTERNAL_WORKSPACE_RANGE = "*";

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export function isValidSemVer(version) {
  return typeof version === "string" && SEMVER_RE.test(version);
}

export function repoRootFrom(importMetaUrl = import.meta.url) {
  return join(dirname(fileURLToPath(importMetaUrl)), "../..");
}

function listDirs(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(rel, d.name));
}

/**
 * Tracked version-bearing paths relative to repo root (excludes fixtures/samples/docs history).
 */
export function discoverVersionFiles(root) {
  const files = new Set(["package.json"]);

  for (const dir of [
    ...listDirs(root, "packages"),
    ...listDirs(root, "plugins"),
    ...listDirs(root, "apps"),
  ]) {
    const pkg = join(dir, "package.json");
    if (existsSync(join(root, pkg))) files.add(pkg.replace(/\\/g, "/"));
    const pluginJson = join(dir, ".claude-plugin/plugin.json");
    if (existsSync(join(root, pluginJson))) {
      files.add(pluginJson.replace(/\\/g, "/"));
    }
    const marketJson = join(dir, ".claude-plugin/marketplace.json");
    if (existsSync(join(root, marketJson))) {
      files.add(marketJson.replace(/\\/g, "/"));
    }
  }

  for (const extra of [
    "plugins/ba/canon-graph/package.json",
    "tools/e2e/package.json",
    "tools/scripts/package.json",
    "packages/catalog/catalog.json",
  ]) {
    if (existsSync(join(root, extra))) files.add(extra);
  }

  return [...files].sort();
}

export function readJson(abs) {
  return JSON.parse(readFileSync(abs, "utf8"));
}

export function writeJson(abs, data) {
  writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Extract comparable version string(s) from a version-bearing file.
 * Returns { kind, versions: string[] }.
 */
export function extractVersions(relPath, data) {
  const base = relPath.split("/").pop();
  if (base === "catalog.json") {
    return {
      kind: "catalog",
      versions: (data.plugins ?? []).map((p) => p.version).filter(Boolean),
    };
  }
  if (base === "marketplace.json") {
    return {
      kind: "marketplace",
      versions: (data.plugins ?? []).map((p) => p.version).filter(Boolean),
    };
  }
  if (base === "plugin.json" || base === "package.json") {
    return { kind: "package", versions: data.version ? [data.version] : [] };
  }
  return { kind: "unknown", versions: [] };
}

/**
 * Apply monorepo release version to one file. Returns true if content changed.
 */
export function applyVersionToData(relPath, data, version) {
  const base = relPath.split("/").pop();
  let changed = false;

  if (base === "catalog.json") {
    for (const p of data.plugins ?? []) {
      if (p.version !== version) {
        p.version = version;
        changed = true;
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    if (data.updated !== today) {
      data.updated = today;
      changed = true;
    }
    return changed;
  }

  if (base === "marketplace.json") {
    for (const p of data.plugins ?? []) {
      if (p.version !== version) {
        p.version = version;
        changed = true;
      }
    }
    return changed;
  }

  if (base === "plugin.json" || base === "package.json") {
    if (data.version !== version) {
      data.version = version;
      changed = true;
    }
    return changed;
  }

  return false;
}

export function applyVersionToFile(root, relPath, version) {
  const abs = join(root, relPath);
  const data = readJson(abs);
  const before = JSON.stringify(data);
  applyVersionToData(relPath, data, version);
  const after = JSON.stringify(data);
  if (before === after) return false;
  writeJson(abs, data);
  return true;
}

/**
 * Map of local workspace package names → { path, version }.
 * Only `@praxis/*` packages are treated as internal workspace packages.
 */
export function discoverWorkspacePackages(root) {
  const packages = new Map();
  for (const rel of discoverVersionFiles(root)) {
    if (!rel.endsWith("package.json")) continue;
    const data = readJson(join(root, rel));
    if (typeof data.name === "string" && data.name.startsWith("@praxis/")) {
      packages.set(data.name, { path: rel, version: data.version ?? null });
    }
  }
  return packages;
}

export function listInternalDependencyRefs(root) {
  const workspace = discoverWorkspacePackages(root);
  const refs = [];
  for (const rel of discoverVersionFiles(root)) {
    if (!rel.endsWith("package.json")) continue;
    const data = readJson(join(root, rel));
    for (const section of DEP_SECTIONS) {
      const deps = data[section];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, range] of Object.entries(deps)) {
        if (!workspace.has(name)) continue;
        refs.push({
          path: rel,
          section,
          name,
          range: String(range),
          packageVersion: workspace.get(name).version,
        });
      }
    }
  }
  return refs;
}

export function applyInternalWorkspaceDeps(
  data,
  workspaceNames,
  range = INTERNAL_WORKSPACE_RANGE,
) {
  let changed = false;
  for (const section of DEP_SECTIONS) {
    const deps = data[section];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) {
      if (!workspaceNames.has(name)) continue;
      if (deps[name] !== range) {
        deps[name] = range;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Rewrite every dependency on a local `@praxis/*` workspace package to
 * {@link INTERNAL_WORKSPACE_RANGE} (`*`).
 */
export function syncInternalWorkspaceDeps(
  root,
  { dryRun = false, range = INTERNAL_WORKSPACE_RANGE } = {},
) {
  const workspace = discoverWorkspacePackages(root);
  const names = new Set(workspace.keys());
  const changed = [];
  for (const rel of discoverVersionFiles(root)) {
    if (!rel.endsWith("package.json")) continue;
    const abs = join(root, rel);
    const data = readJson(abs);
    const clone = structuredClone(data);
    if (!applyInternalWorkspaceDeps(clone, names, range)) continue;
    changed.push(rel);
    if (!dryRun) writeJson(abs, clone);
  }
  return { changed, range, refs: listInternalDependencyRefs(root) };
}

export function checkInternalWorkspaceDeps(
  root,
  range = INTERNAL_WORKSPACE_RANGE,
) {
  const refs = listInternalDependencyRefs(root);
  const mismatches = refs
    .filter((r) => r.range !== range)
    .map((r) => ({
      path: r.path,
      section: r.section,
      name: r.name,
      found: r.range,
      expected: range,
      packageVersion: r.packageVersion,
    }));
  return { ok: mismatches.length === 0, range, mismatches, refs };
}

export function syncAllVersions(root, version, { dryRun = false } = {}) {
  const files = discoverVersionFiles(root);
  const changed = [];
  for (const rel of files) {
    const abs = join(root, rel);
    const data = readJson(abs);
    const clone = structuredClone(data);
    const willChange = applyVersionToData(rel, clone, version);
    if (!willChange) continue;
    changed.push(rel);
    if (!dryRun) writeJson(abs, clone);
  }
  const depSync = syncInternalWorkspaceDeps(root, { dryRun });
  for (const rel of depSync.changed) {
    if (!changed.includes(rel)) changed.push(rel);
  }
  return { files, changed, depChanged: depSync.changed };
}

/**
 * Consistency report: every version-bearing field must equal expected (root by default),
 * and every internal `@praxis/*` dependency must use the workspace protocol.
 */
export function checkVersionConsistency(root, expectedVersion) {
  const rootPkg = readJson(join(root, "package.json"));
  const expected = expectedVersion ?? rootPkg.version;
  const mismatches = [];
  for (const rel of discoverVersionFiles(root)) {
    const data = readJson(join(root, rel));
    const { versions } = extractVersions(rel, data);
    for (const v of versions) {
      if (v !== expected) {
        mismatches.push({ path: rel, found: v, expected });
      }
    }
  }
  const deps = checkInternalWorkspaceDeps(root);
  for (const m of deps.mismatches) {
    mismatches.push({
      path: m.path,
      found: `${m.name}@${m.found}`,
      expected: `${m.name}@${m.expected}`,
      kind: "internal-dependency",
      section: m.section,
      packageVersion: m.packageVersion,
    });
  }
  return {
    ok: mismatches.length === 0,
    expected,
    mismatches,
    files: discoverVersionFiles(root),
    internalDeps: deps,
  };
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export { relative, join };
