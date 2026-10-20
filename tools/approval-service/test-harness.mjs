/**
 * Test harness for the Approval Service. Everything here runs as ONE OS identity, so it exercises the service's
 * logic, protocol, executor and WebAuthn verification for real, but it is NOT evidence of independent-OS-identity
 * isolation. See ISOLATION-ACCEPTANCE.md for the tests that need the installed service and the owner.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { callApprovalService } from "../../packages/contracts/dist/index.js";
import { createSoftwareAuthenticator } from "../broker/test-authenticator.mjs";
import { createService } from "./lib/service.mjs";
import { openEnrollmentWindow } from "./lib/enroll.mjs";

export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = netServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

export const sh = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
export const git = (cwd, ...args) => sh(cwd, "git", ...args);

export function makeRepo(root, name, { withRemote = true } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Agent");
  git(dir, "config", "user.email", "agent@example.invalid");
  writeFileSync(join(dir, "README.md"), "# seed\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "seed");
  let remote;
  if (withRemote) {
    remote = join(root, `${name}-remote.git`);
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(dir, "remote", "add", "origin", remote);
  }
  return { dir, remote };
}

export const stage = (repo, file, text) => {
  writeFileSync(join(repo, file), text);
  git(repo, "add", file);
};

export async function startService({ root, repos, mode = "development", probe, providersConfig, extraConfig = {}, state } = {}) {
  const base = root ?? mkdtempSync("/tmp/pas-");
  const stateDir = state ?? join(base, "state");
  const endpoint = join(base, "s.sock");
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const config = {
    mode,
    principal: "test",
    repositories: repos ?? [],
    operator: { port, origin },
    identity: { name: "Praxis Approval Service", email: "approval-service@localhost" },
    ...(providersConfig ? { providers: providersConfig } : {}),
    ...extraConfig,
  };
  const paths = { stateDir, endpoint, configFile: join(base, "config.json"), codeDir: base, id: "test" };
  const service = await createService({
    paths,
    config,
    mode,
    version: "test",
    platformId: "test",
    probe: probe ?? (() => [{ id: "development-identity", ok: false, detail: "test harness runs as the same identity as the agent" }]),
  });
  await service.listen();
  const call = (message) => callApprovalService(message, { endpoint, timeoutMs: 30_000 });
  const device = createSoftwareAuthenticator({ rpId: "localhost", origin });
  const post = async (path, body) => {
    const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  const enroll = async (dev = device) => {
    const { code } = openEnrollmentWindow(stateDir, origin);
    const c = await post("/api/enroll/challenge", { secret: code, label: "tester" });
    if (c.status !== 200) throw new Error(`enroll challenge failed: ${JSON.stringify(c.json)}`);
    const reg = dev.register({ challenge: c.json.publicKey.challenge });
    const fin = await post("/api/enroll/finish", { secret: code, challengeId: c.json.challengeId, credential: { id: reg.id, response: { clientDataJSON: reg.clientDataJSON, attestationObject: reg.attestationObject } } });
    if (fin.status !== 200) throw new Error(`enroll failed: ${JSON.stringify(fin.json)}`);
  };
  /** The operator's act: a user-verified WebAuthn assertion over the challenge for this exact plan. */
  const decide = async (planId, decision = "approve", dev = device) => {
    const c = await post("/api/challenge", { planId, decision });
    if (c.status !== 200) return { status: c.status, json: c.json };
    const a = dev.assert({ challenge: c.json.publicKey.challenge });
    return post("/api/decide", { challengeId: c.json.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } });
  };
  const planFile = (planId, where = "pending") => join(stateDir, "shared", where, `${planId}.json`);
  return { service, call, device, enroll, decide, post, origin, port, stateDir, endpoint, base, planFile, config, paths, close: () => service.close() };
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
