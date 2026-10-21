// Runs AS ROOT inside the acceptance container. Root plays the human operator (software authenticator, TEST ONLY) and
// the administrator; every agent action is a separate process under the unprivileged `agent` user.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createSoftwareAuthenticator } from "/core/tools/broker/test-authenticator.mjs";

const ENDPOINT = "/run/praxis-approval/service.sock";
const ORIGIN = "http://localhost:8780";
const results = [];
const say = (ok, name, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sh = (cmd, opts = {}) => {
  try {
    return { code: 0, out: execFileSync("sh", ["-c", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};
const asAgent = (cmd) => sh(`runuser -u agent -- sh -c ${JSON.stringify(cmd)}`);
const agentCall = (payload) => {
  const r = sh(`runuser -u agent -- node /core/tools/approval-service/acceptance/agent-call.mjs ${ENDPOINT} call '${JSON.stringify(payload).replaceAll("'", "'\\''")}'`);
  return JSON.parse(r.out.trim().split("\n").pop());
};
const agentAssess = () => JSON.parse(sh(`runuser -u agent -- node /core/tools/approval-service/acceptance/agent-call.mjs ${ENDPOINT} assess`).out.trim().split("\n").pop());
const git = (cwd, args) => sh(`cd ${cwd} && git -c safe.directory="*" ${args}`).out.trim();
const CTL = "/opt/praxis-approval-service/current/ctl.sh";
const NODE = "/opt/praxis-approval-service/current/node/bin/node";
const SVC = "/opt/praxis-approval-service/current/praxis-approval-service.mjs";
const CFG = "/etc/praxis-approval/config.json";

let service;
const startService = async () => {
  // umask 000 stands in for the inheritable ACL the owner sets on each repository (INSTALL.md): files and directories the service creates stay writable by the repository owner
  service = spawn("runuser", ["-u", "praxis-approval", "--", "sh", "-c", `umask 000; exec env -i PATH=/usr/bin:/bin ${NODE} ${SVC} run --config ${CFG}`], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  service.stderr.on("data", (d) => (log += d));
  await new Promise((resolve, reject) => {
    service.stdout.on("data", (d) => String(d).includes("\n") && resolve());
    service.on("exit", (c) => reject(new Error(`service exited ${c}: ${log}`)));
  });
};
const stopService = async () => {
  service.removeAllListeners("exit");
  service.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
};

const post = async (path, body) => {
  const r = await fetch(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const device = createSoftwareAuthenticator({ rpId: "localhost", origin: ORIGIN });
const decide = async (id, decision = "approve") => {
  const c = await post("/api/challenge", { planId: id, decision });
  const a = device.assert({ challenge: c.json.publicKey.challenge });
  return post("/api/decide", { challengeId: c.json.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } });
};

try {
  // ---- the service as shipped: production mode, its own uid, verified isolation -------------------------------------------------
  await startService();
  const ctl = sh(`${CTL} health`);
  say(ctl.code === 0 && /healthy/.test(ctl.out), "L1 ctl health: production mode, isolation verified, integrity ok", ctl.code === 0 ? "" : ctl.out.slice(0, 600));
  const health = agentCall({ op: "health" }).health;
  say(health?.mode === "production" && health.isolation.verified === true, "L2 an unprivileged client sees mode=production, isolation.verified=true", JSON.stringify(health?.isolation?.checks?.filter((c) => !c.ok)));
  const assessed = agentAssess();
  say(assessed.isolated === true, "L3 the agent-side client independently judges the service isolated (endpoint owned by another uid, directory not writable)", JSON.stringify(assessed.reasons));
  const owner = sh(`ps -o user= -p $(pgrep -f "praxis-approval-service.mjs run" | tail -n 1) ; stat -c '%U' ${ENDPOINT}`).out.trim().split("\n");
  say(owner.every((o) => o.trim().startsWith("praxis-appr")) , "L4 the service process and its socket belong to praxis-approval", owner.join(","));

  // ---- the boundary: what the agent cannot do ------------------------------------------------------------------------------------
  const denied = (cmd) => asAgent(cmd).code !== 0;
  say(denied("cat /var/lib/praxis-approval/trusted/private.pem"), "L5 agent cannot read the signing key");
  say(denied("ls /var/lib/praxis-approval"), "L6 agent cannot list the state directory");
  say(denied("echo x >> /var/lib/praxis-approval/audit/chain.jsonl"), "L7 agent cannot append to the audit log");
  say(denied("echo x >> /var/lib/praxis-approval/ledger/c-x.json"), "L8 agent cannot write the ledger");
  say(denied("echo x > /etc/praxis-approval/config.json"), "L9 agent cannot change the privileged configuration");
  say(denied(`echo x > ${SVC}`) && denied("echo x > /opt/praxis-approval-service/current/node/bin/node"), "L10 agent cannot modify the service code or its Node runtime");
  say(denied(`rm -f ${ENDPOINT}`) && denied(`mv ${ENDPOINT} ${ENDPOINT}.x`), "L11 agent cannot remove or replace the socket");
  say(denied(`kill $(pgrep -f "praxis-approval-service.mjs run" | tail -n 1)`), "L12 agent cannot signal the service");
  say(denied("cat /var/lib/praxis-approval/trusted/enroll.json") && denied("echo '{}' > /var/lib/praxis-approval/trusted/enroll.json"), "L13 agent cannot read or open the enrollment window");
  say(denied("mkdir /var/lib/praxis-approval/shared/authorizations/x") , "L14 agent cannot plant an authorization token");
  say(denied(`cat /proc/$(pgrep -f "praxis-approval-service.mjs run" | tail -n 1)/environ`) && denied(`cat /proc/$(pgrep -f "praxis-approval-service.mjs run" | tail -n 1)/mem`), "L15 agent cannot read the service's memory or environment");
  const unknown = agentCall({ op: "approve", requestId: "x" });
  say(unknown.code === "UNKNOWN_OPERATION", "L16 the IPC has no approve operation");

  // ---- enrollment is the owner's act, through the service identity -------------------------------------------------------------
  const code = /: ([a-f0-9]{20})\n/.exec(sh(`runuser -u praxis-approval -- env -i PATH=/usr/bin:/bin ${NODE} ${SVC} enroll-code --config ${CFG}`).out)?.[1];
  const c1 = await post("/api/enroll/challenge", { secret: code, label: "acceptance" });
  const reg = device.register({ challenge: c1.json.publicKey.challenge });
  const fin = await post("/api/enroll/finish", { secret: code, challengeId: c1.json.challengeId, credential: { id: reg.id, response: { clientDataJSON: reg.clientDataJSON, attestationObject: reg.attestationObject } } });
  say(fin.status === 200, "L17 the owner enrolled an authenticator with a code only the service identity could create");

  // ---- approved and rejected Git execution, idempotency --------------------------------------------------------------------------
  const repo = "/home/agent/repo";
  git(repo, "checkout -q -b feature/lx");
  sh(`chmod -R a+rwX ${repo}/.git /home/agent/remote.git`); // what the inheritable ACL does for directories the owner creates
  sh(`cd ${repo} && echo "hello linux" > lx.txt`);
  const commit = { op: "submit", operation: "git_commit", repository: repo, workItemId: "WI-LX", params: { message: "linux acceptance", paths: ["lx.txt"] }, executionId: "ex-lx-commit" };
  const s1 = agentCall(commit);
  say(s1.ok && s1.state === "awaiting-operator", "L18 agent submits; the service proposes and waits for the owner");
  say(agentCall({ op: "execute", requestId: s1.requestId }).code === "APPROVAL_REQUIRED", "L19 execute before approval is refused");
  say((await decide(s1.requestId)).status === 200, "L20 the owner approves through the WebAuthn page");
  const headBefore = git(repo, "rev-parse HEAD");
  const done = agentCall({ op: "execute", requestId: s1.requestId });
  const headAfter = git(repo, "rev-parse HEAD");
  say(done.ok && done.result?.commit === headAfter && headAfter !== headBefore, "L21 the service performed one commit", done.ok ? "" : JSON.stringify(done).slice(0, 600));
  say(git(repo, "log -1 --format=%an").startsWith("Praxis Approval") && git(repo, "show --name-only --format= HEAD") === "lx.txt", "L22 the commit is authored by the service and contains exactly the named path");
  const replay = agentCall(commit);
  say(replay.state === "completed" && replay.result.commit === headAfter && git(repo, "rev-parse HEAD") === headAfter, "L23 same execution id after HEAD moved: recorded result, no second commit");
  say(agentCall({ ...commit, params: { ...commit.params, message: "changed" } }).code === "CHANGED_PLAN", "L24 a changed plan under the same execution id is refused");

  const push = { op: "submit", operation: "git_push", repository: repo, workItemId: "WI-LX", params: { remote: "origin", branch: "feature/lx" }, executionId: "ex-lx-push" };
  const p1 = agentCall(push);
  const remoteBefore = git("/home/agent/remote.git", "for-each-ref refs/heads");
  say(remoteBefore === "" && agentCall({ op: "execute", requestId: p1.requestId }).ok === false, "L25 push is a separate request; nothing is pushed without its own approval");
  await decide(p1.requestId);
  const pushed = agentCall({ op: "execute", requestId: p1.requestId });
  say(pushed.ok && git("/home/agent/remote.git", "rev-parse refs/heads/feature/lx") === headAfter, "L26 approved push reaches the remote with the service's credentials path", pushed.ok ? "" : JSON.stringify(pushed).slice(0, 500));
  sh(`cd ${repo} && git -c safe.directory="*" -c user.name=x -c user.email=x@x commit -q --allow-empty -m moved`);
  say(agentCall(push).state === "completed", "L27 push replay by execution id after the repository moved: recorded result");

  const rej = agentCall({ op: "submit", operation: "git_commit", repository: repo, workItemId: "WI-LX", params: { message: "to be rejected", paths: ["lx.txt", "lx2.txt"] }, executionId: "ex-lx-rej" });
  sh(`cd ${repo} && echo two > lx2.txt`);
  const rej2 = agentCall({ op: "submit", operation: "git_commit", repository: repo, workItemId: "WI-LX", params: { message: "to be rejected 2", paths: ["lx2.txt"] }, executionId: "ex-lx-rej2" });
  const before2 = git(repo, "rev-parse HEAD");
  await decide(rej2.requestId, "reject");
  say(agentCall({ op: "execute", requestId: rej2.requestId }).code === "APPROVAL_REJECTED" && git(repo, "rev-parse HEAD") === before2, "L28 a rejected request changes nothing");
  void rej;
  const refs = git(repo, "for-each-ref --format=%(refname)");
  say(!/approv|token/i.test(refs) && !/approv|token|ledger/i.test(git(repo, "ls-files")), "L29 no approval branches, refs or files in the user's repository");

  // ---- fail closed ------------------------------------------------------------------------------------------------------------------
  await stopService();
  const down = agentCall({ op: "submit", operation: "git_commit", repository: repo, workItemId: "WI-LX", params: { message: "x", paths: ["lx2.txt"] } });
  say(down.ok === false && /SERVICE_UNAVAILABLE/.test(down.code), "L30 service stopped: the client fails closed (nothing executes anywhere else)");
  const downAssess = agentAssess();
  say(downAssess.reachable === false && downAssess.isolated === false, "L31 service stopped: the client reports unreachable and not isolated");
  // a fake service by the agent on its own path is never judged isolated
  const fakeServer = spawn("runuser", ["-u", "agent", "--", "node", "-e", "require('net').createServer(s=>s.end(JSON.stringify({ok:true,protocol:'praxis.approval-service.v1',health:{service:'praxis-approval-service',version:'9',protocol:'praxis.approval-service.v1',mode:'production',platform:'linux',uptimeSec:1,isolation:{verified:true,principal:'x',checks:[]},operatorChannel:{url:'x',enrolledAuthenticators:1},pending:0,auditChain:{ok:true,entries:0},ledgerEntries:0}})+'\\n')).listen('/home/agent/fake.sock')"], { stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1200));
  const fake = JSON.parse(sh(`runuser -u agent -- node /core/tools/approval-service/acceptance/agent-call.mjs /home/agent/fake.sock assess`).out.trim().split("\n").pop());
  say(fake.reachable === true && fake.isolated === false, "L32 an agent-owned impostor claiming production isolation is judged NOT isolated", JSON.stringify(fake.reasons));
  fakeServer.kill("SIGKILL");

  // ---- backup, upgrade, rollback, health, uninstall ----------------------------------------------------------------------------
  const ledgerBefore = readdirSync("/var/lib/praxis-approval/ledger").length;
  const v1 = sh(`ls /opt/praxis-approval-service`).out;
  const up = sh(`cd /pkg2/* && sh install.sh upgrade`);
  say(up.code === 0 && /installed/.test(up.out), "L33 upgrade to the next version succeeds (compatibility checks, backup, atomic switch)", up.code ? up.out.slice(0, 500) : "");
  say(readdirSync("/var/backups/praxis-approval").length >= 1, "L34 a backup was taken before the upgrade");
  say(readdirSync("/var/lib/praxis-approval/ledger").length === ledgerBefore && existsSync("/etc/praxis-approval/config.json"), "L35 state and root-owned configuration survived the upgrade");
  await startService();
  say(sh(`${CTL} health`).code === 0, "L36 healthy after upgrade, with the old anchors and ledger intact");
  say(agentCall(commit).state === "completed", "L37 the recorded commit result is still returned after the upgrade (ledger preserved)");
  await stopService();
  const down2 = sh(`cd /pkg2/* && sh install.sh upgrade --dry-run`);
  say(down2.code === 0 && /DRY-RUN/.test(down2.out), "L38 --dry-run changes nothing");
  const dg = sh(`cd /pkg/* && sh install.sh upgrade`);
  say(dg.code !== 0 && /newer than/.test(dg.out), "L39 a downgrade is refused unless explicitly allowed");
  const rb = sh(`${CTL} rollback`);
  say(rb.code === 0 && /rolled back/.test(rb.out), "L40 rollback switches back to the previous version", rb.out.slice(0, 300));
  await startService();
  say(sh(`${CTL} health`).code === 0 && sh(`cat /opt/praxis-approval-service/current/MANIFEST.json`).out.includes('"version"'), "L41 healthy after rollback");
  await stopService();
  const bad = sh(`cd /tmp && rm -rf badpkg && cp -r /pkg/* badpkg && echo tampered >> badpkg/payload/praxis-approval-service.mjs && sh badpkg/install.sh check`);
  say(bad.code !== 0 && /SHA256SUMS/.test(bad.out), "L42 a tampered package is refused by the checksum check");
  const un = sh(`${CTL} uninstall`);
  say(un.code === 0 && !existsSync("/opt/praxis-approval-service") && existsSync("/var/lib/praxis-approval") && existsSync("/var/backups/praxis-approval"), "L43 uninstall removes code and unit, keeps state and a backup");
  const purge = sh(`cd /pkg/* && sh install.sh install >/dev/null && /opt/praxis-approval-service/current/ctl.sh uninstall --purge`);
  say(purge.code === 0 && !existsSync("/var/lib/praxis-approval") && sh("id praxis-approval").code !== 0, "L44 uninstall --purge removes state, configuration and the account (backup kept)");
} catch (error) {
  say(false, "acceptance run", error.stack ?? String(error));
} finally {
  try {
    service?.kill("SIGKILL");
  } catch {
    /* gone */
  }
}
const failed = results.filter((r) => !r).length;
console.log(`LINUX-CONTAINER ${failed === 0 ? "PASS" : "FAIL"}: ${results.length - failed}/${results.length} checks`);
process.exit(failed === 0 ? 0 : 1);
void statSync;
void readFileSync;
void writeFileSync;
