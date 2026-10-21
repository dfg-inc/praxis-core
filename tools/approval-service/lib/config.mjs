import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { adapterFor } from "../platform/index.mjs";

const REMOTE_NAME = /^[A-Za-z0-9._-]+$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

/** Remote URLs the service may use: https, ssh (URL or scp form), file, or an absolute local path. Never an option, never ext::, never userinfo secrets. */
export function remoteUrlProblem(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return "must be a non-empty string";
  if (url.startsWith("-")) return "must not start with '-'";
  if (/[\u0000-\u001f\u007f\s]/.test(url)) return "must not contain whitespace or control characters";
  if (/^[a-z][a-z0-9+.-]*::/i.test(url)) return "transport helpers (scheme::) are not accepted";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (scheme) {
    if (!["https", "ssh", "file"].includes(scheme)) return `scheme ${scheme} is not accepted (https, ssh, file only)`;
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(url)[1];
    if (scheme === "https" && authority.includes("@")) return "https URLs must not embed credentials";
    if (scheme === "ssh" && /:[^@]*@/.test(authority)) return "ssh URLs must not embed a password";
    return undefined;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^:]/.test(url)) return undefined; // scp-like git@host:owner/repo
  if (isAbsolute(url)) return undefined;
  return "must be an https, ssh or file URL, an scp-like address, or an absolute path";
}

/**
 * Reads and validates the service configuration (a root-owned JSON file in production).
 * In production the platform adapter's locations and principal are authoritative: the document cannot move the state
 * directory, the code directory or the endpoint, nor change which account the probe expects.
 */
export function loadConfig(file, os) {
  const adapter = adapterFor(os);
  const defaults = adapter.defaults();
  let doc;
  let configFile = file;
  try {
    configFile = realpathSync(file);
    doc = JSON.parse(readFileSync(configFile, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the service configuration ${file}: ${error.message}`);
  }
  const problems = [];
  if (doc.mode !== "production" && doc.mode !== "development") problems.push('"mode" must be "production" or "development"');
  if (!Array.isArray(doc.repositories ?? [])) problems.push('"repositories" must be an array');
  for (const [index, repo] of (doc.repositories ?? []).entries()) {
    const at = `repositories[${index}]`;
    if (!repo || typeof repo !== "object") {
      problems.push(`${at} must be an object`);
      continue;
    }
    if (!repo.path || !isAbsolute(repo.path)) problems.push(`${at}.path must be an absolute path`);
    if (!Array.isArray(repo.branches) || repo.branches.length === 0 || repo.branches.some((b) => typeof b !== "string" || b.length === 0)) problems.push(`${at}.branches must list the branches the service may touch (an empty or missing list allows none)`);
    for (const [name, url] of Object.entries(repo.remotes ?? {})) {
      if (!REMOTE_NAME.test(name) || RESERVED.has(name)) problems.push(`${at}.remotes has an unacceptable name ${JSON.stringify(name)}`);
      const issue = remoteUrlProblem(url);
      if (issue) problems.push(`${at}.remotes.${name}: ${issue}`);
    }
    if (repo.provider !== undefined && (typeof repo.provider.kind !== "string" || typeof repo.provider.instanceId !== "string")) problems.push(`${at}.provider needs kind and instanceId`);
  }
  for (const [kind, grants] of Object.entries(doc.providers ?? {})) {
    for (const [instance, grant] of Object.entries(grants.instances ?? {})) {
      if (grant.apiBase !== undefined && !/^https:\/\//.test(grant.apiBase)) problems.push(`providers.${kind}.${instance}.apiBase must be an https URL`);
      if (grant.repo !== undefined && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(grant.repo)) problems.push(`providers.${kind}.${instance}.repo must be owner/name`);
    }
  }
  if (doc.path !== undefined && (typeof doc.path !== "string" || !doc.path.split(":").every((p) => isAbsolute(p)))) problems.push('"path" must be a colon-separated list of absolute directories');
  if (problems.length) throw new Error(`invalid service configuration: ${problems.join("; ")}`);
  const production = doc.mode === "production";
  // The probe inspects the file that was actually loaded, not a default path the owner may not be using.
  const paths = production ? { ...defaults, configFile } : { ...defaults, ...(doc.paths ?? {}), configFile: doc.paths?.configFile ?? configFile };
  return { adapter, paths, config: { ...doc, principal: production ? defaults.principal : (doc.principal ?? defaults.principal), repositories: doc.repositories ?? [] } };
}
