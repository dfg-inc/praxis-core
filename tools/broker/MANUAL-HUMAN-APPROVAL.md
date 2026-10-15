# Manual human approval acceptance (Gate G1)

Automated fixtures that call `approve` with `PRAXIS_BROKER_MACHINE_APPROVE=1` are **not** proof that a person approved a plan.

## Prerequisites

- Broker identity can read `PRAXIS_BROKER_TRUSTED_DIR/private.pem`.
- Agent cannot read that directory.
- A real terminal attached to the broker process (not the agent).

## Steps

1. As the agent (or any planner), propose a plan:

```bash
node tools/broker/praxis-broker.mjs propose --plan /path/to/plan.json
```

2. On a **broker-owned TTY**, show the plan:

```bash
export PRAXIS_BROKER_TRUSTED_DIR=...
export PRAXIS_BROKER_SHARED_DIR=...
export PRAXIS_APPROVAL_PRIVATE_KEY_PATH=$PRAXIS_BROKER_TRUSTED_DIR/private.pem
node tools/broker/praxis-broker.mjs show --plan-id <id>
```

3. Approve interactively — type the exact fingerprint line:

```bash
node tools/broker/praxis-broker.mjs approve-interactive --plan-id <id> --approver <you>
# prompt shows the plan
# type: APPROVE sha256:...
```

4. Confirm the audit record under `$PRAXIS_BROKER_TRUSTED_DIR/audit/<id>.json` has `"channel":"interactive-tty"`.

5. Run the executor with the issued token.

6. Negative checks:
   - Pipe `APPROVE …` into `approve-interactive` → must fail (no TTY).
   - Call `approve` without `PRAXIS_BROKER_MACHINE_APPROVE=1` → must fail.
   - Change the plan file after show → fingerprint mismatch on typed confirmation.

## Status for Milestone 1.4

Record the operator name, date, plan id, and fingerprint here when executed:

- Operator:
- Date:
- Plan id:
- Fingerprint:
- Result: PENDING

Until this section is filled by a real operator session, Gate **G1** remains **BLOCKED** for human-operated proof, even if automated denial tests PASS.
