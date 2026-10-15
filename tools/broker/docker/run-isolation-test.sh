#!/usr/bin/env bash
# Two-UID isolation test using Docker. Agent uid 1000 cannot access trusted secrets.
# Broker/executor uid 1001 owns private key, credentials, and ledger.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
image=${PRAXIS_ISOLATION_IMAGE:-node:20-bookworm-slim}
workdir=$(mktemp -d "${TMPDIR:-/tmp}/praxis-isolation.XXXXXX")
trusted="$workdir/trusted"
shared="$workdir/shared"
mkdir -p "$trusted" "$shared/pending" "$shared/authorizations" "$trusted/ledger" "$trusted/audit"
touch "$trusted/.broker-identity"

# Build contracts for the broker scripts
(cd "$root" && npm run build -w @praxis/contracts >/dev/null)

node - <<'NODE' "$trusted" "$shared"
const { generateApprovalKeyPair } = require(process.argv[2] + "/packages/contracts/dist/index.js");
const fs = require("fs");
const trusted = process.argv[3];
const keys = generateApprovalKeyPair();
fs.writeFileSync(trusted + "/private.pem", keys.privateKeyPem);
fs.writeFileSync(trusted + "/public.pem", keys.publicKeyPem);
fs.writeFileSync(trusted + "/credentials.json", JSON.stringify({
  jiraToken: "trusted-jira-token-not-for-agent",
  gitToken: "trusted-git-token-not-for-agent",
}, null, 2));
NODE
"$root" "$trusted"

chmod 700 "$trusted"
chmod 600 "$trusted/private.pem" "$trusted/credentials.json"

contracts_entry=/workspace/packages/contracts/dist/index.js
broker=/workspace/tools/broker/praxis-broker.mjs
executor=/workspace/tools/broker/praxis-executor.mjs

run_agent() {
  docker run --rm \
    --user 1000:1000 \
    -v "$root:/workspace:ro" \
    -v "$shared:/shared" \
    -v "$trusted:/trusted:ro" \
    -e PRAXIS_BROKER_SHARED_DIR=/shared \
    -e PRAXIS_BROKER_TRUSTED_DIR=/trusted \
    -e PRAXIS_CONTRACTS_ENTRY="$contracts_entry" \
    "$image" \
    bash -lc "$1"
}

run_broker() {
  docker run --rm \
    --user 1001:1001 \
    -v "$root:/workspace:ro" \
    -v "$shared:/shared" \
    -v "$trusted:/trusted" \
    -e PRAXIS_BROKER_SHARED_DIR=/shared \
    -e PRAXIS_BROKER_TRUSTED_DIR=/trusted \
    -e PRAXIS_APPROVAL_PRIVATE_KEY_PATH=/trusted/private.pem \
    -e PRAXIS_APPROVAL_PUBLIC_KEY_PATH=/trusted/public.pem \
    -e PRAXIS_APPROVAL_LEDGER=/trusted/ledger \
    -e PRAXIS_CONTRACTS_ENTRY="$contracts_entry" \
    "$image" \
    bash -lc "$1"
}

run_executor() {
  docker run --rm \
    --user 1001:1001 \
    -v "$root:/workspace:ro" \
    -v "$shared:/shared" \
    -v "$trusted:/trusted" \
    -e PRAXIS_BROKER_SHARED_DIR=/shared \
    -e PRAXIS_BROKER_TRUSTED_DIR=/trusted \
    -e PRAXIS_APPROVAL_PUBLIC_KEY_PATH=/trusted/public.pem \
    -e PRAXIS_APPROVAL_LEDGER=/trusted/ledger \
    -e PRAXIS_CONTRACTS_ENTRY="$contracts_entry" \
    "$image" \
    bash -lc "$1"
}

fail=0
pass() { printf 'PASS %s\n' "$1"; }
blocked() { printf 'FAIL %s\n' "$1"; fail=1; }

# 1. Agent cannot read broker private key
if run_agent 'cat /trusted/private.pem' >/dev/null 2>&1; then
  blocked "agent_read_private_key"
else
  pass "agent_cannot_read_private_key"
fi

# 2. Agent cannot write trusted ledger
if run_agent 'echo forged > /trusted/ledger/x.json' >/dev/null 2>&1; then
  blocked "agent_write_ledger"
else
  pass "agent_cannot_write_ledger"
fi

# 3. Agent cannot read credentials
if run_agent 'cat /trusted/credentials.json' >/dev/null 2>&1; then
  blocked "agent_read_credentials"
else
  pass "agent_cannot_read_credentials"
fi

# 4. Agent cannot approve (no broker identity / private key access for signing path)
if run_agent "node $broker approve --plan-id missing --approver agent" >/dev/null 2>&1; then
  blocked "agent_approve"
else
  pass "agent_cannot_approve"
fi

# Prepare plan as agent (propose is allowed into shared inbox)
plan_json="$shared/pending/plan-demo.json"
node - <<'NODE' "$root" "$plan_json"
const { buildActionPlan } = require(process.argv[2] + "/packages/contracts/dist/index.js");
const fs = require("fs");
const now = new Date();
const plan = buildActionPlan({
  planId: "plan-demo",
  role: "developer",
  decisionKind: "git_operation",
  summary: "Connect origin remote for WP-1",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: ["WP-1"],
  storyIds: [],
  decisionIds: [],
  repositories: ["/workspace"],
  actions: [{ action: "praxis_developer_git_connect_apply", description: "add origin", targets: ["origin"] }],
  risks: ["remote mutation"],
  sideEffects: ["git remote add"],
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3600000).toISOString(),
});
fs.mkdirSync(require("path").dirname(process.argv[3]), { recursive: true });
fs.writeFileSync(process.argv[3], JSON.stringify(plan, null, 2));
NODE

# Fix ownership for uid mounts
chmod -R a+rwX "$shared" || true

# Broker shows and approves
run_broker "node $broker show --plan-id plan-demo" >/tmp/praxis-broker-show.txt
grep -q "Connect origin remote" /tmp/praxis-broker-show.txt && pass "broker_shows_exact_plan" || blocked "broker_shows_exact_plan"
run_broker "node $broker approve --plan-id plan-demo --approver operator" >/tmp/praxis-broker-approve.txt
grep -q '"ok":true' /tmp/praxis-broker-approve.txt && pass "broker_signs_authorization" || blocked "broker_signs_authorization"

# 5. Forged token rejected
echo "forged" > "$shared/authorizations/forged.token"
chmod a+rw "$shared/authorizations/forged.token"
if run_executor "node $executor execute --token /shared/authorizations/forged.token --action praxis_developer_git_connect_apply" >/dev/null 2>&1; then
  blocked "forged_token_rejected"
else
  pass "forged_token_rejected"
fi

# 6. Legitimate approved operation succeeds once
run_executor "node $executor execute --token /shared/authorizations/plan-demo.token --action praxis_developer_git_connect_apply --payload /shared/pending/plan-demo.json" >/tmp/praxis-exec1.txt || true
# payload shape differs - write a matching payload
node - <<'NODE' "$shared"
const fs = require("fs");
const plan = JSON.parse(fs.readFileSync(process.argv[2] + "/pending/plan-demo.json", "utf8"));
fs.writeFileSync(process.argv[2] + "/payload.json", JSON.stringify({
  planFingerprint: plan.fingerprint,
  provider: plan.provider,
  instanceId: plan.instanceId,
  operation: plan.operations[0],
  workItemId: plan.workItemIds[0],
  repository: plan.repositories[0],
}));
NODE
"$shared"
run_executor "node $executor execute --token /shared/authorizations/plan-demo.token --action praxis_developer_git_connect_apply --payload /shared/payload.json" >/tmp/praxis-exec1.txt
grep -q '"replayed":false' /tmp/praxis-exec1.txt && pass "approved_operation_once" || blocked "approved_operation_once"

# 7. Duplicate does not execute again
run_executor "node $executor execute --token /shared/authorizations/plan-demo.token --action praxis_developer_git_connect_apply --payload /shared/payload.json" >/tmp/praxis-exec2.txt
grep -q '"replayed":true' /tmp/praxis-exec2.txt && pass "duplicate_replay" || blocked "duplicate_replay"

# 8. Changed provider rejected
node - <<'NODE' "$shared"
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[2] + "/payload.json", "utf8"));
p.provider = "jira";
fs.writeFileSync(process.argv[2] + "/payload-bad.json", JSON.stringify(p));
NODE
"$shared"
if run_executor "node $executor execute --token /shared/authorizations/plan-demo.token --action praxis_developer_git_connect_apply --payload /shared/payload-bad.json" >/dev/null 2>&1; then
  blocked "changed_provider_rejected"
else
  pass "changed_provider_rejected"
fi

# 9. Agent cannot retrieve credentials via executor (no identity)
if run_agent "node $executor health" >/dev/null 2>&1; then
  blocked "agent_executor_health"
else
  pass "agent_cannot_run_executor"
fi

printf 'workdir %s\n' "$workdir"
if [ "$fail" -ne 0 ]; then
  printf 'ISOLATION_TEST FAIL\n'
  exit 1
fi
printf 'ISOLATION_TEST PASS\n'
