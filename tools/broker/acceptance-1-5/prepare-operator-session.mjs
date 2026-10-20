#!/usr/bin/env node
/**
 * Prepares an isolated Milestone 1.5 operator acceptance workspace.
 * Does not approve anything. Does not touch the operator's real Claude config.
 *
 * Creates:
 *   $OUT/trusted  — broker secrets (mode 0700)
 *   $OUT/shared   — pending plans / authorizations
 *   $OUT/project  — fixture acceptance project
 *   $OUT/claude-isolated — disposable Claude Code config dir
 *   $OUT/OPERATOR-INSTRUCTIONS.md
 *   $OUT/RESULTS.md (blank template)
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const contracts = require(join(coreRoot, "packages/contracts/dist/index.js"));

const outArg = process.argv.indexOf("--out");
const out =
  outArg >= 0
    ? resolve(process.argv[outArg + 1])
    : mkdtempSync(join(tmpdir(), "praxis-m15-op-"));

mkdirSync(join(out, "trusted", "audit"), { recursive: true });
mkdirSync(join(out, "trusted", "ledger"), { recursive: true });
mkdirSync(join(out, "shared", "pending"), { recursive: true });
mkdirSync(join(out, "shared", "authorizations"), { recursive: true });
mkdirSync(join(out, "shared", "rejected"), { recursive: true });
mkdirSync(join(out, "project", ".praxis"), { recursive: true });
mkdirSync(join(out, "claude-isolated"), { recursive: true });
mkdirSync(join(out, "logs"), { recursive: true });

writeFileSync(join(out, "trusted", ".broker-identity"), "broker\n");
const keys = contracts.generateApprovalKeyPair();
writeFileSync(join(out, "trusted", "private.pem"), keys.privateKeyPem);
writeFileSync(join(out, "trusted", "public.pem"), keys.publicKeyPem);
writeFileSync(
  join(out, "trusted", "credentials.json"),
  `${JSON.stringify({ note: "synthetic fixture credentials only", jiraToken: "SYNTHETIC" }, null, 2)}\n`,
);
chmodSync(join(out, "trusted"), 0o700);
chmodSync(join(out, "trusted", "private.pem"), 0o600);
chmodSync(join(out, "trusted", "credentials.json"), 0o600);

writeFileSync(
  join(out, "project", "README.md"),
  `# Praxis M1.5 acceptance fixture project\n\nLocal only. No production writes.\n`,
);
writeFileSync(
  join(out, "project", ".praxis", "fixture-marker.json"),
  `${JSON.stringify({ purpose: "m1.5-acceptance", createdAt: new Date().toISOString() }, null, 2)}\n`,
);

const now = new Date();
const stamp = Date.now();
const rejectId = `m15-reject-${stamp}`;
const approveId = `m15-approve-${stamp}`;
const acceptedPath = join(out, "project", "accepted.txt");
const fixtureContent = "accepted-by-operator\n";
const rejectPlan = contracts.buildActionPlan({
  planId: rejectId,
  role: "developer",
  decisionKind: "development_action",
  summary: "REJECT THIS — intentional bad mutation for G1 step 3",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: ["WP-REJECT"],
  storyIds: [],
  decisionIds: [],
  repositories: [join(out, "project")],
  actions: [
    {
      action: "praxis_workflow_apply",
      description: "would overwrite fixture-marker.json with BAD",
      targets: [join(out, "project", ".praxis", "fixture-marker.json")],
      content: "BAD\n",
    },
  ],
  risks: ["intentional reject"],
  sideEffects: ["none if rejected"],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
});
const approvePlan = contracts.buildActionPlan({
  planId: approveId,
  role: "developer",
  decisionKind: "development_action",
  summary: "Approve — single fixture mutation of accepted.txt",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: ["WP-OK"],
  storyIds: [],
  decisionIds: [],
  repositories: [join(out, "project")],
  actions: [
    {
      action: "praxis_workflow_apply",
      description: "create accepted.txt once",
      targets: [acceptedPath],
      content: fixtureContent,
    },
  ],
  risks: [],
  sideEffects: ["writes accepted.txt"],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
});
mkdirSync(join(out, "plans"), { recursive: true });
writeFileSync(join(out, "plans", "reject.json"), `${JSON.stringify(rejectPlan, null, 2)}\n`);
writeFileSync(join(out, "plans", "approve.json"), `${JSON.stringify(approvePlan, null, 2)}\n`);
const execPayload = {
  planId: approvePlan.planId,
  planFingerprint: approvePlan.fingerprint,
  provider: approvePlan.provider,
  instanceId: approvePlan.instanceId,
  operation: approvePlan.operations[0],
  action: approvePlan.actions[0].action,
  workItemId: approvePlan.workItemIds[0],
  repository: approvePlan.repositories[0],
  targets: approvePlan.actions[0].targets,
  contentDigest: contracts.approvedContentDigest(fixtureContent),
};
writeFileSync(join(out, "plans", "exec-payload.json"), `${JSON.stringify(execPayload, null, 2)}\n`);

const envFile = `export PRAXIS_BROKER_TRUSTED_DIR=${out}/trusted
export PRAXIS_BROKER_SHARED_DIR=${out}/shared
export PRAXIS_APPROVAL_PRIVATE_KEY_PATH=${out}/trusted/private.pem
export PRAXIS_APPROVAL_PUBLIC_KEY_PATH=${out}/trusted/public.pem
export PRAXIS_APPROVAL_LEDGER=${out}/trusted/ledger
export PRAXIS_CONTRACTS_ENTRY=${coreRoot}/packages/contracts/dist/index.js
export PRAXIS_SECURITY_MODE=secure
export PRAXIS_FIXTURE_EXECUTION=1
# Host Cursor agents with Docker Desktop must NOT claim docker-uid PASS.
# unset PRAXIS_DEPLOYMENT_MODEL unless the agent process lacks docker.sock.
unset PRAXIS_BROKER_MACHINE_APPROVE
export CLAUDE_CONFIG_DIR=${out}/claude-isolated
`;
writeFileSync(join(out, "env.sh"), envFile);

const marketplaceRc = join(coreRoot, "../praxis-marketplace/release-candidate");
const instructions = `# Operator acceptance — Milestone 1.5 (G1 / G3)

Workspace: \`${out}\`

Do **not** share private.pem. Do **not** use production Jira credentials.

## A. Start protected operator channel

\`\`\`bash
source ${out}/env.sh
cd ${coreRoot}
node tools/broker/praxis-broker.mjs serve-operator
\`\`\`

Leave that process running. Expected: \`{"ok":true,"listening":".../operator.sock","channel":"operator-socket"}\`

## B. Propose reject plan (agent or helper)

In a **second** terminal:

\`\`\`bash
source ${out}/env.sh
cd ${coreRoot}
node tools/broker/praxis-broker.mjs propose --plan ${out}/plans/reject.json
\`\`\`

## C. Operator REJECT (you)

Third terminal (your TTY as operator):

\`\`\`bash
source ${out}/env.sh
cd ${coreRoot}
node tools/broker/praxis-operator-console.mjs --plan-id ${rejectId} --approver "$USER"
\`\`\`

Type exactly: \`REJECT\`

Confirm: \`${out}/trusted/audit/${rejectId}.json\` has \`"state":"rejected"\` and \`${acceptedPath}\` still does **not** exist.

## D. Propose approve plan

\`\`\`bash
source ${out}/env.sh
cd ${coreRoot}
node tools/broker/praxis-broker.mjs propose --plan ${out}/plans/approve.json
\`\`\`

## E. Operator APPROVE (you)

\`\`\`bash
source ${out}/env.sh
cd ${coreRoot}
node tools/broker/praxis-operator-console.mjs --plan-id ${approveId} --approver "$USER"
\`\`\`

Type exactly: \`APPROVE <fingerprint shown>\`

Expected fingerprint: \`${approvePlan.fingerprint}\`

## F. Executor once (broker identity; no private key in env)

JSON success without \`${acceptedPath}\` is a **FAIL**.

\`\`\`bash
source ${out}/env.sh
unset PRAXIS_APPROVAL_PRIVATE_KEY_PATH PRAXIS_APPROVAL_PRIVATE_KEY
cd ${coreRoot}
test ! -f ${acceptedPath}
TOKEN=${out}/shared/authorizations/${approveId}.token
PAYLOAD=${out}/plans/exec-payload.json
node tools/broker/praxis-executor.mjs execute \\
  --token "$TOKEN" \\
  --action praxis_workflow_apply \\
  --payload "$PAYLOAD" | tee ${out}/logs/exec-1.json
# Observable side effect required
test -f ${acceptedPath}
grep -x 'accepted-by-operator' ${acceptedPath}
# Second run must report replayed:true and must not change the file
cp ${acceptedPath} ${out}/logs/accepted.before-replay
node tools/broker/praxis-executor.mjs execute \\
  --token "$TOKEN" \\
  --action praxis_workflow_apply \\
  --payload "$PAYLOAD" | tee ${out}/logs/exec-2.json
cmp ${acceptedPath} ${out}/logs/accepted.before-replay
\`\`\`

Confirm \`exec-1.json\` has \`"replayed":false\` and \`mutated\`, and \`exec-2.json\` has \`"replayed":true\`.

## G. Claude Code host (G3) — isolated config only

\`\`\`bash
source ${out}/env.sh
# Install from local RC without touching ~/.claude
# Example (adjust to your Claude Code plugin install flags):
# claude --config-dir "$CLAUDE_CONFIG_DIR" plugin marketplace add ${marketplaceRc}
\`\`\`

Copy-ready prompts (paste into the isolated Claude Code chat):

1. \`Initialize Praxis runtime and run diagnostics. Report MCP tool count.\`
2. \`As BA: capture requirement "Fixture login rate limit" in this project.\`
3. \`Create four Stories for that requirement.\`
4. \`As Architect: record DEC-001..DEC-011 for the fixture.\`
5. \`Present an implementation plan for work package WP-OK; do not mutate without broker approval.\`
6. \`Attempt a protected write without present-plan — expect rejection.\`

## Record results

Edit \`${out}/RESULTS.md\` — mark PASS/FAIL yourself. Return that file plus:

- \`${out}/trusted/audit/*.json\`
- Claude session log if any under \`${out}/claude-isolated\`
- Do **not** return private.pem

## Cleanup

\`\`\`bash
rm -rf ${out}
\`\`\`

## Threat reminder

This host Cursor agent can see Docker Desktop sockets. That is **not** the supported secure agent identity. Secure docker-uid validation requires an agent process without \`docker.sock\`.
`;

writeFileSync(join(out, "OPERATOR-INSTRUCTIONS.md"), instructions);
writeFileSync(
  join(out, "RESULTS.md"),
  `# M1.5 operator results (fill by hand)

- Operator name:
- Date:
- Reject plan id: ${rejectId} — PASS/FAIL:
- Approve plan id: ${approveId} — fingerprint: ${approvePlan.fingerprint}
- Approve channel operator-socket — PASS/FAIL:
- accepted.txt created with accepted-by-operator — PASS/FAIL:
- Executor single mutation — PASS/FAIL:
- Replay left file unchanged — PASS/FAIL:
- Claude Code host tools used (list):
- G1 verdict: PENDING
- G3 verdict: PENDING
`,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      out,
      rejectFingerprint: rejectPlan.fingerprint,
      approveFingerprint: approvePlan.fingerprint,
      instructions: join(out, "OPERATOR-INSTRUCTIONS.md"),
      env: join(out, "env.sh"),
    },
    null,
    2,
  ),
);
