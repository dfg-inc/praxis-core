# Security review of the Approval Service

Two review rounds, plus the author's own adversarial tests. "Fixed" means a regression test fails without the fix and
passes with it; "documented" means the limit is stated in README.md and was not removed.

Reviewers: round 1 and round 2 were read-only reviews by independent agent sessions (round 1 was cut short by a tooling
safety stop and said so; round 2 covered the areas round 1 had not). Neither is a substitute for a human security
review or for the isolation acceptance on an installed service. Nothing here was verified by a person.

## Round 1 (first milestone)
| Id | Finding | Status |
|---|---|---|
| F-NAS-001 | The standalone CLI loaded a repository `.env` with no key filter (could set `PRAXIS_SECURITY_MODE=compatibility` or the approval-service endpoint) | Fixed: filtered loader; `dotenv-trust.test.ts` |
| F-NAS-002 | Repository-setting screening was a deny pattern (accepted `merge.<n>.driver`, HTTP transport keys) | Fixed: explicit allow-list; `units.test.mjs` (36 refused keys) |
| F-NAS-003 | Only `.git` itself was checked for symlinks | Fixed: whole-tree walk; `units.test.mjs`, `service.test.mjs` |
| F-NAS-004 | Any local process could grow the audit chain with malformed requests | Fixed: counted and sampled |
| F-NAS-005 | The independent review was incomplete | Closed by round 2 below, with the limits stated there |
| F-NAS-006 | Truncation or rollback of the audit chain was not detectable | Fixed, see "Audit pinning" |

## Round 2 (this milestone)
| Id | Sev | Finding | Status |
|---|---|---|---|
| H1 | High | Loopback impersonation: the operator origin is `http://localhost:PORT` but only 127.0.0.1 was held; a process could serve a false page on `::1` | Fixed: both loopback addresses are held; the service refuses to start if `::1` is taken. A host without IPv6 is fine. Documented: while the service is down nothing can be approved, and the owner must use the URL the service prints. A TLS-protected page bound to a key the agent lacks would remove the residual; not built. |
| H2 | High | Repository `.git/config` was validated once then used by `push`/`ls-remote`; flipping `core.sshCommand`, `http.proxy`, `url.*.insteadOf` during execution could run code as the service or redirect a credentialed push | Fixed: push runs from a service-owned bare repository whose object store points at the repository (no repository config is read); `ls-remote` runs against a service-owned empty repository; further keys neutralised on the remaining local commands; file contents are hashed as raw bytes (`hash-object --no-filters`) so no clean filter can run. `units.test.mjs` proves a hostile parent `.git` is never consulted. Residual (documented): local read commands still run inside the repository with the screened config; the window between screening and use is milliseconds and the dangerous keys are neutralised on the command line. |
| M1 | Med | Nested symlinks under `.git` (refs, logs, objects fan-out) not rejected | Fixed |
| M2 | Med | Uninstall wrote a root-owned backup containing the signing key to the user's home with a predictable name and then deleted state even if tar failed | Fixed: root-only backup directory, mode 0600/0700, failure aborts |
| M3 | Med | Agent text could forge lines in the approval view (work item id, file names with newlines, bidi characters) | Fixed: strict work item charset, JSON-quoted text with control/bidi characters shown as `\uXXXX`, paths with control characters refused |
| M4 | Med | A merge-request body was approved by hash only | Fixed: shown quoted, length-limited |
| M5 | Med | An expired approval permanently blocked re-approval of the same plan | Fixed: spent approvals are archived with an audit entry; failed-with-nothing-changed may be re-proposed; uncertain endings may not |
| M6 | Med | Any local client can issue challenges, so an agent can crowd out the owner's decision (availability only) | Documented. Per-plan cap and total cap bound memory. The agent can delay a decision; it cannot make one. |
| M7 | Med | Linux install plan produced agent-owned code and overwrote root config | Fixed: replaced by `install.sh` (root-owned install, config create-if-missing) |
| M8 | Med | The installer did not verify the ancestors of the code directory | Fixed: macOS code lives under `/Library/Application Support/Praxis/…` and postinstall verifies every ancestor |
| L1 | Low | No limits on queue growth; audit appends re-read the whole file | Fixed: per-repository and total queue caps; audit read cache keyed to the file's size and mtime |
| L2 | Low | A failing audit write after a successful execution could turn it into a reported failure | Fixed |
| L3 | Low | Crash between moving the plan and writing the token left an approval that could never be used | Fixed: start-up recovery; token written last |
| L4 | Low | Default branch policy allowed everything; `__proto__` as a remote name | Fixed: default deny; reserved names refused; own-property lookups |
| L5 | Low | Configuration validation gaps (URL forms, apiBase, ls-remote without `--`, token file modes) | Fixed: `config.mjs` validation, `--`, file-mode refusal |
| L6 | Low | The probe checked the default config path, not the file loaded | Fixed: the loaded file is the one checked; production ignores `paths` and `principal` in the document |
| L7 | Low | Git PATH included user-writable directories | Fixed: `/usr/bin:/bin` unless the root-owned config names a path |
| L8 | Low | macOS postinstall could reuse a UID / set no password | Fixed |
| L9 | Low | Enrollment lockout is an availability trade; secret entropy | 80-bit code; lockout after five misses until a new window is opened. Documented |
| L10 | Low | `askpass` rewritten on every call | Fixed: written once at start |
| L11 | Low | `executionId` digest depended on key order | Fixed: canonical form |
| I1 | Info | The socket is world-reachable by design | Documented in README |
| I2 | Info | Anchors share the state directory | Fixed by independent sinks and an off-host witness, see below |
| I3 | Info | Failed assertions and enrollments were not audited | Fixed: counted and sampled |

## Audit pinning (F-NAS-006)
After every audit append the service writes a **signed** record of the head (sequence, hash, number of consumed approvals)
to `state/anchors/` and to every directory in the root-owned config key `auditAnchorDirs`. At start and before every
execution the chain and ledger are compared with all sinks:

* a chain shorter than an anchor, or a different hash at the anchored sequence → truncation or rollback;
* a ledger with fewer consumptions than an anchor, or an audited consumption missing from the ledger → ledger rollback (replay);
* one sink anchored and another empty or behind → a sink was deleted or restored; a forged anchor → invalid signature.

The service refuses to start on any of these and refuses to execute if one appears while running (`APPROVAL_INTEGRITY_FAILED`).
`audit-witness` prints a signed head the owner stores **off the machine**; `audit-verify --witness FILE` checks the chain
against it. Limits: an attacker who can rewrite the chain, every sink and the signing key together defeats the sinks, which is
why the off-host witness exists; the witness only proves what it was taken at. Tests: truncated tail, whole-state rollback with
an independent sink, deleted sink, forged anchor, rolled-back ledger, a mismatch while running, concurrent writers, witness.

## Areas covered and what was not
Operator page and WebAuthn (XSS, CSRF, Host/Origin, challenge binding and single use, UV, RP ID, replay, enrollment):
`operator-ui.test.mjs`, plus both reviews' reading. Installer: macOS scripts and Linux `install.sh` reviewed by reading; Linux
installer, upgrade, rollback and uninstall executed in a Linux container; macOS scripts only statically checked and the package
inspected; Windows installer and service host **never run**. Executor and Git: tests and both reviews.

Not independently verified: the Windows pieces end to end; macOS under a real separate account; systemd's sandbox directives;
real Touch ID / security keys; Git hosting providers other than the fixture (GitHub is implemented and unexercised).
A third review pass should read the Windows installer, the service host and anything added after this document.
