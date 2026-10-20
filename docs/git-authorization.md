# Git authorization through the broker inbox

Status: implemented and tested end to end through the packaged MCPB with the real broker program. A person's
approval, OS-level isolation and an out-of-process executor are **not** proven here; see "What is not proven".

## Chain

```
Developer (agent)         asks:      praxis_developer_git_{commit,publish,merge_request,connect_apply,identity_apply}
  -> Runtime (guardWrite)  builds:   the exact plan from the live preview; derives planId; writes it to pending/
  -> Broker (separate process, holds the key)
                           shows:    the plan to the owner; on the owner's authenticated act signs a token
                                     (channel = webauthn:<credential> | operator-socket) into authorizations/<planId>.token
  -> Runtime (executor)    verifies: signature, expiry, channel, plan binding, replay ledger, and that the repository is
                                     still exactly what was approved; then runs the Git operation once under a lease
  -> Quality evidence      the result is recorded by the normal Git delivery journal
```

## One request, one plan, one token

| Bound field | Where |
| --- | --- |
| repository (absolute) | plan.repositories, token, request content |
| operation: `git_commit`, `git_push`, `merge_request`, `repository_edit` | plan.operations, token.operations |
| action (the tool) | plan.actions[0].action, token.action |
| work item / work package | plan.workItemIds, token.workItemIds |
| provider | `local` |
| instance | `local` for commit/connect/identity; the remote identity (`github.com/owner/repo`) for push and merge request |
| target | plan.actions[0].targets: `branch:`, `file@sha256`, `refspec:`, `merge-request:a->b` (token.targets) |
| revision | HEAD / commit sha inside the signed content |
| preview fingerprint | planId derivation and signed content |
| plan fingerprint | token.planFingerprint |
| content | token.contentDigest = sha256 of the canonical request |

planId = `git-<operation>-<24 hex of sha256(operation, action, repository, work item, preview fingerprint)>`. The same
request always yields the same plan (replay is idempotent); any bound change yields a different plan that needs its own
approval. Commit, push and merge request are different operations, so one approval never authorizes another. `merge` is
named by the contract as a separate operation; no tool performs it.

## Trust boundaries

| Party | May | May not |
| --- | --- | --- |
| Agent | call the apply tool; write `pending/` | create or see a token; token is not in responses, arguments or the environment |
| Broker | hold the signing key; write `authorizations/`, `approved/`, `rejected/`; show the owner the plan | execute Git operations |
| Runtime (executor) | verify and execute | sign; trust anything in `pending/`; accept a `machine`-channel token in a production build |

The Runtime process runs as the agent's OS user in this deployment, so it is also the executor. A privileged executor
under another identity (`tools/broker/praxis-executor.mjs`) remains the production path and does not yet perform Git.

## Refusals (no side effect, approval not consumed unless it ran)

| Situation | Code |
| --- | --- |
| no broker configured / no trust anchor / host not isolated | `APPROVAL_ISOLATION_UNAVAILABLE` |
| no approval yet (plan proposed) | `APPROVAL_REQUIRED` (data: planId, operatorUrl) |
| owner rejected | `APPROVAL_REJECTED` |
| expired | `APPROVAL_EXPIRED` |
| token for another plan/operation/instance/target, or repository state changed | `APPROVAL_SCOPE_MISMATCH` |
| stale preview | `GIT_PREVIEW_STALE` |
| machine-issued approval in a production build | `APPROVAL_SELF_GRANT_FORBIDDEN` |
| an approval that already started or failed | `APPROVAL_RECONCILIATION_REQUIRED` |

## Security review of `praxis-runtime/tools/scripts/test-broker.mjs`

| Question | Finding |
| --- | --- |
| Activated from repository files? | No. It reads only the process environment, and requires the caller (an npm script) to set `PRAXIS_TEST_ALLOW_SAME_IDENTITY=1` and to pass `acknowledgeUnisolated: true`. Runtime dotenv rejects `PRAXIS_TEST_*` (acceptance step 14). |
| Usable in the production MCPB? | No. The override is read through `testIdentityOverrideActive()`, which is false when the bundle was compiled with `PRAXIS_BUNDLE_KIND="production"` (a build-time constant). A signed token is still refused on a same-user host (step 13). |
| Test keys in a distribution? | Keys are generated in memory per run. The shipped MCPB and the role ZIPs are scanned for the signer, its marker strings and private-key blocks (step 15, unit test). |
| Can the agent pass a test approval off as a human one? | Test tokens carry `channel: "machine"`; production builds accept only `webauthn:*` or `operator-socket`. The trust anchor of a real deployment never contains a test key. |
| Do checks mask real Executor refusals? | The helper calls the real `runAuthorizedMutation`; errors propagate and the ledger records them. Negative acceptance checks compare HEAD, refs, tree, remote refs, remote URL and pull requests before and after. |
| Do negative tests prove no Git change? | Yes: `snapshot()` in `git-authorization-acceptance.mjs`. |

## What is not proven

- **A person's approval.** The acceptance script drives the real broker with `PRAXIS_BROKER_MACHINE_APPROVE=1`. The
  WebAuthn operator page is tested in `tools/broker/operator-web.test.mjs` with a software authenticator, not with
  hardware, and not against Git plans in the browser.
- **OS isolation.** Broker, Runtime and agent are one user here. Docker remains reachable by this identity.
- **An out-of-process executor** performing Git operations.
- **Jira writes** keep the previous gate (`inspectMutation` plus an environment token); they are not
  covered by this mechanism.
