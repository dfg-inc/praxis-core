import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { adapterFor } from "../platform/index.mjs";

/** Reads the service configuration (a root-owned JSON file in production) and merges it over the platform defaults. */
export function loadConfig(file, os) {
  const adapter = adapterFor(os);
  const defaults = adapter.defaults();
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the service configuration ${file}: ${error.message}`);
  }
  const problems = [];
  if (doc.mode !== "production" && doc.mode !== "development") problems.push('"mode" must be "production" or "development"');
  for (const [index, repo] of (doc.repositories ?? []).entries()) {
    if (!repo.path || !isAbsolute(repo.path)) problems.push(`repositories[${index}].path must be an absolute path`);
    for (const [name, url] of Object.entries(repo.remotes ?? {})) {
      if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url)) problems.push(`repositories[${index}].remotes.${name} embeds credentials`);
    }
  }
  if (problems.length) throw new Error(`invalid service configuration: ${problems.join("; ")}`);
  const paths = { ...defaults, ...(doc.paths ?? {}) };
  return { adapter, paths, config: { principal: defaults.principal, ...doc, repositories: doc.repositories ?? [] } };
}
