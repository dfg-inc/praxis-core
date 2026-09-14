const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeLogicalId(raw: string): string {
  const s = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "story-core";
}

/**
 * Stable BA story identity. Independent of Jira key, time, PID, session, UUID.
 * Format: ba:{epicKey}:{logicalId}
 */
export function baStoryArtifactId(epicKey: string, logicalId: string): string {
  return `ba:${epicKey}:${sanitizeLogicalId(logicalId)}`;
}

export function resolveBaArtifactId(opts: {
  epicKey: string;
  logicalId?: string;
  artifactId?: string;
  requirementIds?: string[];
}): string {
  const proposed = opts.artifactId?.trim();
  if (
    proposed &&
    !UUID_RE.test(proposed) &&
    proposed.startsWith(`ba:${opts.epicKey}:`)
  ) {
    return proposed;
  }
  const logical =
    opts.logicalId ||
    opts.requirementIds?.[0] ||
    (proposed && !UUID_RE.test(proposed) ? proposed : undefined) ||
    "story-core";
  return baStoryArtifactId(opts.epicKey, logical);
}
