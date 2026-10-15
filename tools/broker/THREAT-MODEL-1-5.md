# Threat model distinctions (Milestone 1.5)

## Four boundaries (do not conflate)

| # | Boundary | Evidence status |
| --- | --- | --- |
| 1 | Isolation between container UIDs (agent 1000 vs broker 1001) on **named volumes** | PASS — `docker/run-isolation-test.mjs` |
| 2 | Isolation between the **actual agent** and the Docker daemon | Host Cursor agent on this Mac: **FAIL** (docker.sock reachable). Unprivileged container agent **without** socket: required for secure claim |
| 3 | Isolation between the agent and **trusted operator approval** | PASS for Unix `operator.sock` mode 0600 under trusted dir — agent gets `EACCES`. `approve-interactive` **disabled** (PTY spoofable) |
| 4 | Isolation between the agent and Jira/Git write credentials | PASS under isolation test — credentials only in trusted volume for broker UID |

Passing (1) does **not** establish (2)–(4).

## Supported secure deployment (docker-uid)

1. Agent process runs without access to `/var/run/docker.sock` or Docker Desktop sockets.
2. Broker/executor run as a separate UID with the trusted named volume.
3. Humans approve via `praxis-operator-console.mjs` → `serve-operator` socket only.
4. `PRAXIS_SECURITY_MODE=secure` and `PRAXIS_DEPLOYMENT_MODEL=docker-uid` — if a Docker socket is visible to the process, preflight **fails closed**.

## Explicitly unsupported for G2 PASS

- Host agent (Cursor / Claude Code on macOS Desktop) that can run `docker` and mount trusted volumes.
- Any approval path that only checks `stdin.isTTY` (PTY can spoof).
- Machine approve without broker identity + `PRAXIS_BROKER_MACHINE_APPROVE=1` (test harness only; not human G1).

## macOS host threat model (separate)

Docker Desktop grants the logged-in user daemon control. Named-volume UID ownership is meaningful **inside** Linux containers, but a host process with the socket can start a root container that remounts the volume and reads `private.pem`. Treat host-agent + Docker as **untrusted** for approval secrets.
