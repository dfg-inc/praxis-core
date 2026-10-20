# Manual human approval acceptance (Gate G1)

Automated fixtures that call `approve` with `PRAXIS_BROKER_MACHINE_APPROVE=1` are **not** proof that a person approved a plan.

TTY presence alone is **not** human authentication (a program can open a PTY). Humans must use the protected operator channel: Unix socket `operator.sock` under the broker trusted directory, via `praxis-operator-console.mjs`.

## Prerequisites

- Broker identity can read `PRAXIS_BROKER_TRUSTED_DIR/private.pem`.
- Agent UID cannot read that directory or connect to `operator.sock`.
- Agent process must **not** control Docker (`docker.sock` absent) when claiming docker-uid isolation.
- Operator runs console as the broker-capable identity (or from a host path that can open the socket).

## Steps

1. Start the broker operator socket (broker identity):

```bash
export PRAXIS_BROKER_TRUSTED_DIR=...
export PRAXIS_BROKER_SHARED_DIR=...
export PRAXIS_APPROVAL_PRIVATE_KEY_PATH=$PRAXIS_BROKER_TRUSTED_DIR/private.pem
node tools/broker/praxis-broker.mjs serve-operator
```

2. As the agent (or any planner), propose a plan:

```bash
node tools/broker/praxis-broker.mjs propose --plan /path/to/plan.json
```

3. On the **operator** interface (separate from the agent chat):

```bash
node tools/broker/praxis-operator-console.mjs --plan-id <id> --approver <you>
# shows the plan
# type REJECT  OR  APPROVE sha256:...
```

4. Confirm the audit record under `$PRAXIS_BROKER_TRUSTED_DIR/audit/<id>.json` has `"channel":"operator-socket"`.

5. Run the executor with the issued token and `PRAXIS_FIXTURE_EXECUTION=1`. The approved target file must actually appear with the approved contents. A JSON `"ok":true` without that file is a FAIL. Reject path must leave no usable token and must not create the file.

6. Negative checks:
   - `approve-interactive` → must fail (disabled; PTY spoofable).
   - Call `approve` without `PRAXIS_BROKER_MACHINE_APPROVE=1` → must fail.
   - Agent UID cannot connect to `operator.sock`.
   - Change the plan after show → fingerprint mismatch on typed confirmation.

## Status for Milestone 1.5

Record the operator name, date, plan id, and fingerprint here when executed:

- Operator:
- Date:
- Plan id (reject):
- Plan id (approve):
- Fingerprint approved:
- Result: PENDING

Until this section is filled by a real operator session, Gate **G1** remains **BLOCKED** for human-operated proof, even if automated denial tests PASS.
