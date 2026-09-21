import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileSha256 } from "./git-local.js";

export type QualitySnapshotFile = { path: string; sha256?: string; missing?: boolean };

export type QualitySnapshot = {
  reviewId: number | null;
  verdict: string | null;
  digest: string | null;
  files: QualitySnapshotFile[];
  approvalApplied: boolean;
  source: string | null;
};

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readQualitySnapshot(repo: string, workPackageId: string): QualitySnapshot {
  const primary = join(repo, "design", workPackageId, "qa", "quality-review.json");
  const sidecar = join(repo, ".praxis-jira", "quality", `${workPackageId}.review.json`);
  const raw = readJson(primary) ?? readJson(sidecar);
  const source = raw ? (existsSync(primary) ? primary : sidecar) : null;
  const snapshot = raw?.snapshot && typeof raw.snapshot === "object" ? (raw.snapshot as Record<string, unknown>) : {};
  const files = Array.isArray(snapshot.files) ? (snapshot.files as QualitySnapshotFile[]) : [];
  return {
    reviewId: typeof raw?.reviewId === "number" ? raw.reviewId : null,
    verdict: typeof raw?.verdict === "string" ? raw.verdict : null,
    digest: typeof snapshot.digest === "string" ? snapshot.digest : null,
    files,
    approvalApplied: raw?.approvalApplied === true,
    source,
  };
}

export function liveFileHash(repo: string, rel: string): string | null {
  return fileSha256(repo, rel);
}

export function compareToQualitySnapshot(
  repo: string,
  selected: string[],
  snapshot: QualitySnapshot,
): {
  match: boolean;
  rows: Array<{
    path: string;
    liveSha256: string | null;
    snapshotSha256: string | null;
    consistency: "match" | "mismatch" | "missing-live" | "missing-snapshot";
  }>;
  liveDigest: string;
} {
  const rows = selected.map((path) => {
    const liveSha256 = liveFileHash(repo, path);
    const snap = snapshot.files.find((f) => f.path === path);
    const snapshotSha256 = snap?.sha256 ?? null;
    let consistency: "match" | "mismatch" | "missing-live" | "missing-snapshot" = "match";
    if (!liveSha256) consistency = "missing-live";
    else if (!snapshotSha256) consistency = "missing-snapshot";
    else if (liveSha256 !== snapshotSha256) consistency = "mismatch";
    return { path, liveSha256, snapshotSha256, consistency };
  });
  const liveDigest = createHash("sha256")
    .update(
      JSON.stringify(
        selected.map((path) => {
          const live = liveFileHash(repo, path);
          return live ? { path, sha256: live } : { path, missing: true };
        }),
      ),
    )
    .digest("hex");
  return {
    match: rows.every((r) => r.consistency === "match") && rows.length > 0,
    rows,
    liveDigest,
  };
}
