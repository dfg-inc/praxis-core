# Praxis Approval Service

The Approval Service is the part of Praxis that holds approval authority and performs the protected Git operations
(`git_commit`, `git_push`, `git_merge_request`) **under an operating-system identity the AI agent does not control**.
The agent can ask. A person decides, with Touch ID, Windows Hello or a security key, on a page that shows what the
service itself derived from the repository. Only then does the service act.

It reuses, and does not replace, the existing pieces: Ed25519 signed authorizations, the WebAuthn operator page
(`tools/broker/operator-web.mjs`), plan and fingerprint derivation (`buildGitPlan`, `gitRequestContent`), the token and
plan binding check (`assertTokenBindsPlan`), the replay ledger, and the production-build gates.

## Status per platform (stated separately, on purpose)

| Platform | Installer artifacts | What has actually been run | OS isolation boundary |
|---|---|---|---|
| macOS (Apple Silicon, Intel) | launchd daemon plist, `.pkg` with preinstall/postinstall/ctl (install, upgrade, backup, rollback, uninstall, health), unsigned | service logic, protocol, executor, WebAuthn verification, package build and static checks, on Apple Silicon. **No launchd daemon has been started under a separate macOS account.** | **OS-ISOLATION BLOCKED pending operator** (needs your one-time administrator install) |
| Linux (systemd) | self-contained `.tar.gz` (official Node bundled), `install.sh` (check, install, upgrade, backup, rollback, health, uninstall), hardened systemd unit | the installer, upgrade, rollback, uninstall and the full approve/reject/replay flow **in a Linux container** with separate uids (`npm run accept:approval-service-linux`: LINUX-CONTAINER PASS 44/44), production mode, isolation verified, agent-side client judging the service isolated | **LINUX-CONTAINER PASS**: uid separation on a real Linux kernel. **systemd itself (unit sandboxing, `RuntimeDirectory`, restart) was not run: UNTESTED on a systemd host.** |
| Windows 10/11 | zip with `install.ps1`, a C# service host (compiled at install time), pipe DACL code, ACL-based probe | **Only the `icacls` parsing logic is unit-tested.** The installer, the service host and the pipe DACL have never run on Windows. | **UNTESTED. Not supported.** |

A platform is not called ready unless the service has actually run on it. Read the table as the whole truth: macOS is built but
not installed; Linux has run in a container; Windows has not run at all.

## Components

1. **Runtime client** (`packages/contracts/src/approval-service.ts`, `git-executor-delegate.ts`). Lives in the agent's
   process. Holds no key, no credential. It submits a request, reads status, and asks the service to execute a request
   that is already approved. `praxis_doctor` uses it to report service health and isolation.
2. **Approval service core** (`tools/approval-service/lib/service.mjs`). Request state machine, canonical plan
   derivation, signing, replay ledger, hash-chained audit, health, IPC server, operator page. Platform independent.
3. **Operator UI** (`tools/broker/operator-web.mjs`, reused). Served on `127.0.0.1` by the service. Shows the plan the
   service built; approves or rejects only through a user-verified WebAuthn assertion over a challenge that hashes the
   exact decision.
4. **Trusted executor** (`tools/approval-service/lib/executor.mjs`, `gitx.mjs`, `providers.mjs`). Re-derives, validates
   and performs the operation itself.
5. **Protected audit storage** (`state/audit/chain.jsonl`, `state/ledger/`, `state/trusted/`). Owned by the service
   principal, mode 0700, outside every user repository.
6. **Platform adapters** (`tools/approval-service/platform/`). Paths, isolation probe, install/uninstall plans, unit
   rendering. The core has no dependency on launchd, Keychain or any other platform API.

## IPC contract

Newline-delimited JSON over a local socket (Unix socket on macOS/Linux, named pipe on Windows). Four messages exist:

| Message | Effect |
|---|---|
| `submit` | The agent names an operation, a repository, a work item, and a few validated parameters (commit message, branch, repository-relative paths, remote **name**, merge-request title). The service derives everything else and proposes a plan. |
| `status` | Read the state of a request (`awaiting-operator`, `approved`, `rejected`, `expired`, `executing`, `completed`, `failed`). |
| `execute` | Run a request that a human has approved. Takes only the request id: the agent cannot change anything at execution. |
| `health` | Version, protocol, mode, isolation checks, authenticator count, audit-chain integrity. |

There is no message that approves, rejects, signs, enrolls, changes configuration, or runs a command. Anything else is
refused as `UNKNOWN_OPERATION`; parameters are strict schemas (extra fields are refused), so a privileged capability
cannot appear by accident. The schemas are in `packages/contracts/src/approval-service.ts`.

The socket is reachable by every local user so the Runtime can connect. That is safe by design, and it is a stated
property rather than an accident: any process that can connect (including the agent) can only do the four things above.

## What the service guarantees

* **The human sees what will run.** The plan is built by the service from the repository and its own configuration.
  Agent-supplied text (commit message, subjects, title) is shown, labelled as agent-supplied, and is bound by hash.
* **One approval, one operation, one request.** The plan id derives from operation, action, repository, work item and
  the service's own fingerprint of the live state. A commit approval cannot authorize a push; an approval for one
  repository, revision, path set or message cannot be used for another.
* **A changed plan is not executed.** At execution the service re-derives the live state and compares it with the
  approved content and the approved plan text. A mismatch is refused before the approval is consumed.
* **Replay is idempotent, by execution id.** The caller names one logical operation with an `executionId`. The service binds it to
  the first request it was used for: asking again returns that request's recorded result **even after the repository has moved on**
  (a commit changes HEAD, a push changes the remote), and the same id with different parameters is refused as `CHANGED_PLAN`.
  Concurrent executes make one change. A failed execution that changed nothing may be asked for again (a fresh approval); one that
  ended in uncertainty (`requires_reconciliation`) may not, until the owner has looked.
* **No machine approval.** The service signs only `webauthn:*` channels and verifies the channel again at execution.
  There is no test or machine approval path in it. (The test suite approves through the real WebAuthn page with a
  software authenticator, which is labelled test-only.)
* **Fail closed.** A production service refuses to start, and refuses to execute after drift, when its isolation probe
  fails. The Runtime client treats an unreachable service as "approval unavailable", never as "approved".
* **Git is never a shell.** Argument arrays only, an environment built from scratch, service-owned configuration and
  credentials, repository hooks disabled, and repositories whose local configuration can run code or redirect
  credentials refused. Commit uses plumbing (`write-tree` / `commit-tree` / `update-ref` with an expected old value),
  so no hook, template or signing program runs. Push uses one explicit URL from the service configuration and one
  `<sha>:refs/heads/<branch>` refspec, never forced.
* **Nothing is written to user repositories except the operation itself.** No approval branches, commits or secret
  files. `.praxis/` may hold non-sensitive references; the service writes nothing there.

## Threat model

Assets: the signing key, the ledger, service-held credentials, repository integrity, the operators' authenticators.
Attackers: the AI agent and any process running as the user.

In scope: forged or replayed approvals; look-alike plans; swapping files or refs between approval and execution
(TOCTOU); hooks and configuration inside the repository; credential redirection; path, symlink and `..` substitution;
impersonating the service on its socket; log leakage.

Stated limits (residual risks), none hidden:

* **A same-user host proves nothing.** The tests run as one identity. Independence from the agent exists only when the
  service runs as a different principal, which needs the installed daemon. Until the owner installs it and the
  isolation acceptance runs, no isolation claim is made, and `praxis_doctor` says so.
* **A local commit cannot be exclusive to the service.** The agent can write to the repository, so it can always
  commit locally with its own Git. The service gives you an *approved* commit, not a monopoly on commits. Push is
  different: it is exclusive **only if the agent holds no Git credentials** (HTTPS token, SSH key, credential helper).
  If the agent can push with its own credentials, no service can stop it.
* **The service needs write access to the repository's `.git`** (granted per repository by the owner, e.g. an ACL;
  `praxis-approval-service allow-repo <path>` prints the exact step). That grant is a real exposure of the service
  to a repository the agent controls; the executor's defences against hostile repositories are listed above and
  are tested, not proven complete.
* **Enrollment is a trust root.** Whoever can open an enrollment window (write to the service's state, i.e. the
  service principal or an administrator) can add an authenticator that approves everything. An administrator or kernel
  compromise is out of scope. A virtual authenticator is blocked only while enrollment is closed and its code unknown.
* **Audit pinning has limits.** Signed head records go to sinks (`auditAnchorDirs`, created by the owner) and an off-host witness can be exported. Tests used a separate volume for one sink, but never a sink the service identity cannot write, and never a witness stored off the machine. An attacker who can rewrite the chain, every sink and the signing key together still wins. See SECURITY-REVIEW.md.
* **Review coverage.** Two independent read-only reviews and the regression tests are in SECURITY-REVIEW.md; neither is a human security review, and the Windows pieces were never run.
* **The service shares a repository's `.git` with the agent.** It needs an inheritable write ACL there (per repository, by the owner); files and directories each side creates must stay writable by the other. A repository with unusual Git settings (LFS, worktree configs) is refused.
* **Repositories with other Git settings are refused** (Git LFS, worktree configs): only an explicit list of settings is accepted.
* **UV is not attestation.** The page requires user verification, but enrollment accepts `attestation: none`. Praxis
  does not claim the authenticator is hardware-backed.
* **Merge and release stay separate capabilities** and are not provided by this service.
* **Jira.** The provider interface exists with strict provider/instance/action grants. Jira writes through
  the service are not enabled (no authorized test environment).
  GitHub pull-request creation is implemented but has not been exercised against a live host;
  the fixture provider is what the tests use.

## Running tests

```
npm run test:approval-service      # service logic, protocol, executor, real process, built artifacts (unprivileged)
npm run build:approval-service     # builds dist/approval-service/production (bundle, manifest, platform artifacts)
npm run pack:approval-service-macos # additionally builds the unsigned macOS .pkg
```

Test categories, kept apart so a simulation is never mistaken for proof:

| Category | Where | Proves |
|---|---|---|
| Unit / simulated | `service.test.mjs`, in-process service, software authenticator | logic, protocol, executor, WebAuthn verification, fail-closed behaviour |
| Operator page review | `operator-ui.test.mjs` | XSS, CSRF, Host/Origin, challenge binding, replay, enrollment limits |
| Real service process | `cli.test.mjs` | the service as its own process, its CLI, socket, operator page, honest unisolated report |
| Built artifacts | `packaging/artifact.test.mjs` | production bundle refuses to start on an unverified host and has no dev mode; pkg contents |
| Real Runtime (MCPB) | `praxis-runtime` `accept:service-delegation` | the Runtime's own tools delegate to the service and never hold authority |
| Linux container, separate uids | `npm run accept:approval-service-linux` (needs Docker and the `node:22-bookworm` image) | installer lifecycle and the uid boundary on Linux: PASS 44/44; **not** systemd, **not** a person |
| Independent OS identity (macOS, Windows) | [ISOLATION-ACCEPTANCE.md](ISOLATION-ACCEPTANCE.md) | **OS-ISOLATION BLOCKED pending operator** |
| Human Touch ID / security key | [ISOLATION-ACCEPTANCE.md](ISOLATION-ACCEPTANCE.md) | **HUMAN-APPROVAL BLOCKED pending operator** |

## Windows

Open design questions, recorded rather than guessed: a named-pipe ACL that admits the Runtime client but is not
writable by the agent; how a client proves a pipe belongs to the service (Node cannot read pipe ownership); a service
wrapper (a plain `node.exe` is not a Windows service host). No Windows isolation probe exists, so the service would
report unverified there and a production service would refuse to start.
