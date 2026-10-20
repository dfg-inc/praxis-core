# Praxis Approval Broker (local reference)

Secure mode requires a trust boundary the agent cannot cross.

## Components

| Component | Identity | Responsibility |
| --- | --- | --- |
| `praxis-broker.mjs` | broker UID | Show exact plan; `serve-operator` Unix socket; machine approve only with flag; audit |
| `praxis-operator-console.mjs` | operator / broker identity | Human show/reject/approve via operator socket (TTY alone is not auth) |
| `praxis-executor.mjs` | broker UID | Hold Jira/Git credentials; verify token; consume ledger; perform writes |
| Agent process | agent UID | Propose plans into the shared inbox only; must not reach `operator.sock` or Docker |

## macOS / Linux without permanent system users

Use Docker UIDs for the reference isolation test:

```bash
npm run build -w @praxis/contracts
node tools/broker/docker/run-isolation-test.mjs
```

Agent = uid `1000`. Broker/executor = uid `1001`. Trusted secrets live in a volume owned by `1001`.

Do not create permanent OS users or change host security settings without owner approval.

## Environment

| Variable | Who | Purpose |
| --- | --- | --- |
| `PRAXIS_BROKER_TRUSTED_DIR` | broker/executor | Private key, credentials, ledger, audit |
| `PRAXIS_BROKER_SHARED_DIR` | agent+broker | Pending plans and issued tokens |
| `PRAXIS_APPROVAL_PRIVATE_KEY_PATH` | broker approve only | Signing key |
| `PRAXIS_APPROVAL_PUBLIC_KEY_PATH` | executor / agent secure mode | Verify tokens |
| `PRAXIS_APPROVAL_LEDGER` | executor | Replay ledger outside the agent workspace |
| `PRAXIS_FIXTURE_EXECUTION=1` | executor | Enables the isolated fixture file write only. Production Jira/Git adapters fail closed. |

Claude tool confirmation is UX. Broker approval is the security boundary.
