/**
 * Provider interface for operations that leave the repository. A provider is addressed by (kind, instanceId) and may
 * perform only the actions the service configuration grants it; an unknown provider, instance or action is refused
 * before anything is derived or shown to a human.
 *
 *   fixture    writes a JSON record under the service state; the test/acceptance provider.
 *   github     pull requests over the GitHub REST API with a token from a service-owned file. NOT exercised against a
 *              live host by this repository's tests.
 *   jira       declared, not executable here: no test environment has been authorized, so every write is refused.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitxError } from "./gitx.mjs";

const BLOCKED = {
  jira: "Jira writes through the approval service are not enabled: no authorized Jira test environment is configured, and production writes are out of scope.",
};

export function createProviders({ stateDir, config, fetchImpl = fetch }) {
  const dir = join(stateDir, "providers");

  function assertScope(provider, action) {
    if (BLOCKED[provider.kind]) throw new GitxError("PROVIDER_BLOCKED", BLOCKED[provider.kind]);
    const grants = config.providers?.[provider.kind];
    if (!grants) throw new GitxError("PROVIDER_NOT_AUTHORIZED", `provider ${provider.kind} is not enabled in the service configuration`);
    const instances = grants.instances ?? {};
    const instance = instances[provider.instanceId];
    if (!instance) throw new GitxError("PROVIDER_NOT_AUTHORIZED", `provider instance ${provider.instanceId} is not granted`);
    if (!(instance.actions ?? []).includes(action)) throw new GitxError("PROVIDER_NOT_AUTHORIZED", `action ${action} is not granted on ${provider.instanceId}`);
    return instance;
  }

  async function createMergeRequest(provider, mr) {
    const instance = assertScope(provider, "create_merge_request");
    if (provider.kind === "fixture") {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = readdirSync(dir).filter((f) => f.startsWith("mr-")).length + 1;
      const record = { id, instanceId: provider.instanceId, ...mr, createdAt: new Date().toISOString() };
      writeFileSync(join(dir, `mr-${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      return { id: String(id), url: `fixture://${provider.instanceId}/merge-requests/${id}` };
    }
    if (provider.kind === "github") {
      const tokenFile = instance.tokenFile;
      if (!tokenFile || !existsSync(tokenFile)) throw new GitxError("PROVIDER_CREDENTIAL_MISSING", "no GitHub token is configured for this instance");
      const response = await fetchImpl(`${instance.apiBase ?? "https://api.github.com"}/repos/${instance.repo}/pulls`, {
        method: "POST",
        headers: { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "praxis-approval-service" },
        body: JSON.stringify({ title: mr.title, head: mr.sourceBranch, base: mr.targetBranch, body: mr.body }),
      });
      if (!response.ok) throw new GitxError("PROVIDER_FAILED", `GitHub refused the pull request (HTTP ${response.status})`, { changed: "nothing" });
      const json = await response.json();
      return { id: String(json.number), url: json.html_url };
    }
    throw new GitxError("PROVIDER_NOT_AUTHORIZED", `provider ${provider.kind} cannot create merge requests`);
  }

  return { assertScope, createMergeRequest, blocked: Object.keys(BLOCKED) };
}
