#!/usr/bin/env node
/**
 * Milestone 1.5 security hardening evidence.
 * Distinguishes container UID isolation from host-agent Docker control and
 * proves TTY/PTY is not a human authorization boundary.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const contracts = require(join(root, "packages/contracts/dist/index.js"));
const broker = join(root, "tools/broker/praxis-broker.mjs");
const image = process.env.PRAXIS_ISOLATION_IMAGE || "node:20-bookworm-slim";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const work = mkdtempSync(join(tmpdir(), "praxis-1-5-sec-"));
const trusted = join(work, "trusted");
const shared = join(work, "shared");
mkdirSync(join(trusted, "audit"), { recursive: true });
mkdirSync(join(trusted, "ledger"), { recursive: true });
mkdirSync(join(shared, "pending"), { recursive: true });
mkdirSync(join(shared, "authorizations"), { recursive: true });
writeFileSync(join(trusted, ".broker-identity"), "broker\n");
const keys = contracts.generateApprovalKeyPair();
writeFileSync(join(trusted, "private.pem"), keys.privateKeyPem);
writeFileSync(join(trusted, "public.pem"), keys.publicKeyPem);
writeFileSync(join(trusted, "credentials.json"), JSON.stringify({ jiraToken: "secret-token" }));
chmodSync(join(trusted, "private.pem"), 0o600);
chmodSync(join(trusted, "credentials.json"), 0o600);

const now = new Date();
const plan = contracts.buildActionPlan({
  planId: "sec-1",
  role: "developer",
  decisionKind: "development_action",
  summary: "Security hardening fixture",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: ["WP-1"],
  storyIds: [],
  decisionIds: [],
  repositories: [work],
  actions: [{ action: "praxis_workflow_apply", description: "fixture", targets: [] }],
  risks: [],
  sideEffects: [],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 600_000).toISOString(),
});
writeFileSync(join(shared, "pending", "sec-1.json"), `${JSON.stringify(plan, null, 2)}\n`);

const env = {
  ...process.env,
  PRAXIS_BROKER_TRUSTED_DIR: trusted,
  PRAXIS_BROKER_SHARED_DIR: shared,
  PRAXIS_APPROVAL_PRIVATE_KEY_PATH: join(trusted, "private.pem"),
  PRAXIS_CONTRACTS_ENTRY: join(root, "packages/contracts/dist/index.js"),
};
delete env.PRAXIS_BROKER_MACHINE_APPROVE;

// 1) approve-interactive is disabled (PTY spoof path closed)
const interactive = spawnSync("node", [broker, "approve-interactive", "--plan-id", "sec-1"], {
  encoding: "utf8",
  env,
  input: `APPROVE ${plan.fingerprint}\n`,
});
check(
  "approve_interactive_disabled",
  (interactive.status ?? 1) !== 0 &&
    /PTY|operator-console|disabled/i.test(`${interactive.stdout}${interactive.stderr}`),
);

// 2) Host agent Docker socket visibility + fail-closed docker-uid model
const hostSockets = ["/var/run/docker.sock", `${process.env.HOME}/.docker/run/docker.sock`];
const assessment = contracts.assessDeploymentThreats({ dockerSockets: hostSockets });
check(
  "host_agent_docker_socket_visible",
  assessment.dockerSocketAccessible === true,
  "macOS host threat model — agent on host can control Docker",
);

const prevMode = process.env.PRAXIS_SECURITY_MODE;
const prevModel = process.env.PRAXIS_DEPLOYMENT_MODEL;
const prevAllow = process.env.PRAXIS_ALLOW_DOCKER_SOCKET;
process.env.PRAXIS_SECURITY_MODE = "secure";
process.env.PRAXIS_DEPLOYMENT_MODEL = "docker-uid";
delete process.env.PRAXIS_ALLOW_DOCKER_SOCKET;
let blocked = false;
try {
  contracts.assertSecureDeployment();
} catch {
  blocked = true;
}
check("docker_uid_fails_closed_on_host_with_socket", blocked);
if (prevMode === undefined) delete process.env.PRAXIS_SECURITY_MODE;
else process.env.PRAXIS_SECURITY_MODE = prevMode;
if (prevModel === undefined) delete process.env.PRAXIS_DEPLOYMENT_MODEL;
else process.env.PRAXIS_DEPLOYMENT_MODEL = prevModel;
if (prevAllow === undefined) delete process.env.PRAXIS_ALLOW_DOCKER_SOCKET;
else process.env.PRAXIS_ALLOW_DOCKER_SOCKET = prevAllow;

// 3) Host agent with Docker can mount a trusted named volume and read secrets
const vol = `praxis-host-bypass-${Date.now()}`;
const seed = mkdtempSync(join(tmpdir(), "praxis-seed-"));
writeFileSync(join(seed, "private.pem"), "BROKER_PRIVATE_KEY_MATERIAL\n");
spawnSync("docker", ["volume", "create", vol], { encoding: "utf8" });
spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${seed}:/seed:ro`,
    "-v",
    `${vol}:/trusted`,
    image,
    "bash",
    "-lc",
    "cp /seed/private.pem /trusted/ && chown 1001:1001 /trusted/private.pem && chmod 600 /trusted/private.pem",
  ],
  { encoding: "utf8" },
);
const bypass = spawnSync(
  "docker",
  ["run", "--rm", "-v", `${vol}:/trusted`, image, "bash", "-lc", "cat /trusted/private.pem"],
  { encoding: "utf8" },
);
check(
  "host_docker_control_can_read_trusted_volume",
  (bypass.status ?? 1) === 0 && bypass.stdout.includes("BROKER_PRIVATE_KEY_MATERIAL"),
  "supported deployment must deny host agent Docker control",
);
spawnSync("docker", ["volume", "rm", "-f", vol], { encoding: "utf8" });

// 4) Operator socket: broker UID serves; agent UID cannot connect
const sockVolTrusted = `praxis-sock-t-${Date.now()}`;
const sockVolShared = `praxis-sock-s-${Date.now()}`;
const serveName = `praxis-op-serve-${Date.now()}`;
spawnSync("docker", ["volume", "create", sockVolTrusted], { encoding: "utf8" });
spawnSync("docker", ["volume", "create", sockVolShared], { encoding: "utf8" });
spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${trusted}:/seed:ro`,
    "-v",
    `${shared}:/seed-shared:ro`,
    "-v",
    `${sockVolTrusted}:/trusted`,
    "-v",
    `${sockVolShared}:/shared`,
    image,
    "bash",
    "-lc",
    [
      "cp -a /seed/. /trusted/",
      "mkdir -p /shared/pending /shared/authorizations /shared/rejected",
      "cp -a /seed-shared/pending/. /shared/pending/",
      "chown -R 1001:1001 /trusted /shared",
      "chmod 700 /trusted",
      "chmod 600 /trusted/private.pem /trusted/credentials.json",
    ].join(" && "),
  ],
  { encoding: "utf8" },
);

const commonMounts = [
  "-v",
  `${root}:/workspace:ro`,
  "-v",
  `${sockVolShared}:/shared`,
  "-v",
  `${sockVolTrusted}:/trusted`,
  "-e",
  "PRAXIS_BROKER_SHARED_DIR=/shared",
  "-e",
  "PRAXIS_BROKER_TRUSTED_DIR=/trusted",
  "-e",
  "PRAXIS_CONTRACTS_ENTRY=/workspace/packages/contracts/dist/index.js",
  "-e",
  "PRAXIS_APPROVAL_PRIVATE_KEY_PATH=/trusted/private.pem",
];

const startServe = spawnSync(
  "docker",
  [
    "run",
    "-d",
    "--name",
    serveName,
    "--user",
    "1001:1001",
    ...commonMounts,
    image,
    "node",
    "/workspace/tools/broker/praxis-broker.mjs",
    "serve-operator",
  ],
  { encoding: "utf8" },
);
check("broker_operator_serve_started", (startServe.status ?? 1) === 0, startServe.stderr || startServe.stdout);

spawnSync("docker", ["exec", serveName, "bash", "-lc", "for i in 1 2 3 4 5 6 7 8 9 10; do test -S /trusted/operator.sock && exit 0; sleep 0.2; done; exit 1"], {
  encoding: "utf8",
});

const agentConnect = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--user",
    "1000:1000",
    ...commonMounts,
    image,
    "node",
    "-e",
    "require('net').createConnection('/trusted/operator.sock').on('error',e=>{console.error(e.code||e.message); process.exit(1)}).on('connect',()=>{console.log('CONNECTED'); process.exit(0)})",
  ],
  { encoding: "utf8" },
);
check(
  "agent_cannot_connect_operator_socket",
  (agentConnect.status ?? 1) !== 0 && !/CONNECTED/.test(agentConnect.stdout || ""),
  (agentConnect.stderr || agentConnect.stdout || "").trim(),
);

const brokerShow = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--user",
    "1001:1001",
    ...commonMounts,
    image,
    "node",
    "-e",
    [
      "const net=require('net');",
      "const msg=JSON.stringify({cmd:'show',planId:'sec-1'})+'\\n';",
      "const c=net.createConnection('/trusted/operator.sock');",
      "let b='';",
      "c.on('connect',()=>c.write(msg));",
      "c.on('data',d=>{b+=d; if(b.includes('\\n')){console.log(b.trim()); process.exit(0)}});",
      "c.on('error',e=>{console.error(e); process.exit(1)});",
    ].join(""),
  ],
  { encoding: "utf8" },
);
check(
  "broker_socket_show_works",
  (brokerShow.status ?? 1) === 0 && /"ok":true/.test(brokerShow.stdout || "") && brokerShow.stdout.includes(plan.fingerprint),
  (brokerShow.stdout || brokerShow.stderr || "").slice(0, 200),
);

spawnSync("docker", ["rm", "-f", serveName], { encoding: "utf8" });
spawnSync("docker", ["volume", "rm", "-f", sockVolTrusted, sockVolShared], { encoding: "utf8" });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? "SECURITY_1_5 FAIL" : "SECURITY_1_5 PASS");
console.log(
  JSON.stringify(
    {
      threatModel: {
        containerUidIsolation: "PASS under named volumes when agent lacks Docker control",
        hostAgentDockerControl: assessment.dockerSocketAccessible
          ? "UNTRUSTED — host agent can attach volumes; require agent without docker.sock"
          : "socket absent",
        humanChannel: "operator Unix socket in trusted dir (not TTY alone)",
      },
    },
    null,
    2,
  ),
);
process.exit(failed.length ? 1 : 0);
