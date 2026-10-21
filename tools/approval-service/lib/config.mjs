import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { adapterFor } from "../platform/index.mjs";

const TOP_LEVEL_KEYS = new Set(["mode", "principal", "repositories", "providers", "credentials", "operator", "paths", "auditAnchorDirs", "planTtlMs", "path", "identity"]);
// A key that looks like it holds a secret may only be a reference to a file (it must end in "File"): the value itself never belongs in configuration.
const SECRET_KEY = /(token|secret|password|passphrase|api[-_]?key|private[-_]?key|credential)/i;

function secretProblems(value, path = "") {
  const out = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...secretProblems(v, `${path}[${i}]`)));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const here = path ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k) && !/File$/.test(k) && !["credentials"].includes(k) && typeof v === "string") out.push(`${here} looks like an inline secret: keep secrets in files under the secrets directory and name the file (…File)`);
      out.push(...secretProblems(v, here));
    }
  } else if (typeof value === "string" && /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{10,}|\bxox[abprs]-[A-Za-z0-9-]{10,})/.test(value)) out.push(`${path} contains what looks like a secret value`);
  return out;
}

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
  for (const key of Object.keys(doc)) if (!TOP_LEVEL_KEYS.has(key)) problems.push(`unknown setting "${key}" (a misspelt setting is refused rather than ignored)`);
  problems.push(...secretProblems(doc));
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
  const production = doc.mode === "production";
  if (production) {
    // Production keeps its credentials in the service's own secrets directory and pins its audit head outside the state directory.
    if (defaults.secretsDir) {
      for (const [name, file] of Object.entries(doc.credentials ?? {})) {
        if (typeof file !== "string" || !file.startsWith(`${defaults.secretsDir}/`) || file.includes("..")) problems.push(`credentials.${name} must be a file inside ${defaults.secretsDir}`);
      }
      for (const [kind, grants] of Object.entries(doc.providers ?? {})) {
        for (const [instance, grant] of Object.entries(grants.instances ?? {})) {
          if (grant.tokenFile !== undefined && (!String(grant.tokenFile).startsWith(`${defaults.secretsDir}/`) || String(grant.tokenFile).includes(".."))) problems.push(`providers.${kind}.${instance}.tokenFile must be a file inside ${defaults.secretsDir}`);
        }
      }
    }
    if (defaults.requireExternalAnchor && (!Array.isArray(doc.auditAnchorDirs) || doc.auditAnchorDirs.length === 0)) problems.push('"auditAnchorDirs" must name at least one anchor directory outside the state directory (it lets the service notice a restored or truncated state)');
    for (const dir of doc.auditAnchorDirs ?? []) if (typeof dir !== "string" || !isAbsolute(dir) || dir.startsWith(`${defaults.stateDir}/`) || dir === defaults.stateDir) problems.push(`auditAnchorDirs entry ${JSON.stringify(dir)} must be an absolute path outside the state directory`);
  }
  if (problems.length) throw new Error(`invalid service configuration: ${problems.join("; ")}`);
  // The probe inspects the file that was actually loaded, not a default path the owner may not be using.
  const paths = production ? { ...defaults, configFile } : { ...defaults, ...(doc.paths ?? {}), configFile: doc.paths?.configFile ?? configFile };
  return { adapter, paths, config: { ...doc, principal: production ? defaults.principal : (doc.principal ?? defaults.principal), repositories: doc.repositories ?? [] } };
}
