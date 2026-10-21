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

## Identifier map and the HIGH findings
Round 2 used short ids while the Praxis Work Item uses `F-NAS-nnn`. They map as: H1 = F-NAS-008, H2 = F-NAS-007, M6 = F-NAS-011, round 1 as in the table above.
Every HIGH or CRITICAL finding and its status:

| Finding | Severity | Status | Reproducible test |
|---|---|---|---|
| F-NAS-007 / H2 repository config read by network operations | high | closed | `units.test.mjs` "a hostile .git in a parent of the working directory is never consulted"; `service.test.mjs` hostile-config and nested-link tests |
| F-NAS-008 / H1 operator page impersonation on `::1` | high | closed with a stated residual | `service.test.mjs` "held on both loopback addresses… will not start if another process holds the port on ::1". Residual: the page is not TLS-bound to a service-held key |
| F-NAS-009 installed-service isolation never run on macOS/Windows, systemd untested | high | **OPEN, needs the owner** | Linux container 44/44 is the only executed boundary test; macOS plan in MACOS-ACCEPTANCE.md |
| F-NAS-010 no real person has approved anything | high | **OPEN, needs the owner** | MACOS-ACCEPTANCE.md steps D to F |

No critical findings are known. The two open HIGH items cannot be closed by code or by an agent: they are acceptance runs on an installed service with a person present.

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
| M6 / F-NAS-011 | Med | Any local client can issue challenges, so an agent could crowd out or evict the owner's decision | **Fixed.** Challenges are stateless (the id is the record plus an HMAC under a per-process key): issuing one stores nothing, so there is nothing to fill, evict or exhaust, and a challenge issued before a flood still decides after it. A challenge is recorded as spent only after an assertion VERIFIED, which only the owner's authenticator can produce, so the spent list cannot be grown by an attacker either. Forging or altering an id (plan, decision, expiry) fails the HMAC. `operator-ui.test.mjs` (flood of 3000 requests; forgery). Remaining abuse surface, bounded and not an authorization matter: CPU use by a local process, and the submit queue (50 waiting requests per repository, 500 total; requests that expired undecided stop counting). |
| M7 | Med | Linux install plan produced agent-owned code and overwrote root config | Fixed: replaced by `install.sh` (root-owned install, config create-if-missing) |
| M8 | Med | The installer did not verify the ancestors of the code directory | Fixed: macOS code lives under `/Library/Application Support/Praxis/…` and postinstall verifies every ancestor (extended to every location, before extraction: F-NAS-014) |
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

## macOS installer hotfix (independent analysis of the scripts inside the built package)
An independent analysis of the REAL scripts in the PKG found the problems below. "Fixed" here means a sandboxed adversarial test of
the scripts taken from the built package fails without the fix (`macos-installer.test.mjs`; `rollback.test.mjs` for the service side).
Sandboxed means: real files, modes, symlinks and macOS ACLs (`chmod +a`) in a temporary tree; account and launchd commands are shims
that record what they would do. It proves the scripts' logic, not what macOS does as root: that is the owner's installation.

| Id | Sev | Finding | Status |
|---|---|---|---|
| F-NAS-014 | High | preinstall checked only the base directory (link, owner) AFTER nothing was extracted yet, but not its ancestors, not the other locations (state, run, secrets, anchors, backups, log directory and its parent, `/Library/LaunchDaemons`, the plist destination), not mode bits, not macOS ACLs and not dangling links: a planted link or an ACL on any of them could redirect the installer's root writes | **Fixed.** `psec_*` checks (shared library inlined into all three scripts) on every ancestor chain and every location before anything is extracted: no link (dangling included), owner root (the service's own directories may be `_praxisapproval`), no group/other write, no write-granting ACL entry (allow entries with write, append, add_file, add_subdirectory, delete, delete_child, writeattr, writeextattr, writesecurity or chown; deny and read-only entries are accepted); an existing code tree or backup with links, writable or set-id entries or write ACLs is refused. 70+ adversarial cases, each also asserting the sandbox is byte-for-byte unchanged and no account or service command was issued. postinstall repeats the checks on what was extracted. |
| F-NAS-015 | High | An existing `_praxisapproval` was accepted by name only (any UID, a login shell, a home directory, a password, admin membership, a UID/GID shared with another account) | **Fixed.** `acct_validate`: RealName must be this installer's, UID and GID in 1–499 and unique, GID = UID, the group agrees, shell/home/hidden/password/authentication authority/admin and other group membership all checked. An interrupted installation (group only, user only, some attributes missing) is completed, never replaced; attributes that are present and wrong refuse. |
| F-NAS-016 | Med | `config.json` is world-readable (0644) and the configuration could carry credentials | **Fixed.** Configuration is public settings only: the loader refuses inline secrets (secret-shaped keys not ending in `File`, token and private-key patterns) and unknown keys; on macOS production, credentials and `tokenFile`s must be files inside `secrets/` (0700, service-owned) and the executor refuses a credential file that is not owned by the service or is readable by group/others. `auditAnchorDirs` (an external sink) is required. |
| F-NAS-017 | High | `rollback --restore-state` made consumed approvals look unused | **Fixed.** `rollback` restores CODE only; ledger, audit, anchors, keys are untouched (`rollback.test.mjs`). State restoration is a separate command, `restore-state <backup>`, refused while the service runs and unless nothing in the CURRENT state changed in the last 25 hours (an earlier version gated on the backup's age, which proves nothing: see F-NAS-022), validates the archive (only `state`, `secrets`, `anchors`, `config.json`; plain files and directories only; no absolute or `..` paths), saves the current state first, unpacks aside and swaps. It does NOT restore the anchors, so the service refuses an older state: that is the protection working. |
| F-NAS-018 | Med | `uninstall --purge` mixed removal of the service with deletion of data | **Fixed.** Three separate levels: `uninstall` keeps everything protected; `--remove-data` removes live data and the account only after a recovery archive was written to `backups/`; `--delete-everything praxis-delete-all-data` (exact phrase) also deletes the backups. `--purge` is refused with an explanation. A failed backup stops every level. |
| F-NAS-019 | Med | A file planted in the code directory between extraction and postinstall would be kept and made root-owned | **Fixed.** postinstall accepts exactly `MANIFEST.json`, `ctl.sh`, `node/bin/node`, `praxis-approval-service.mjs`, with deterministic modes. |
| F-NAS-020 | Med | The installed permissions were never verified; a wrong mode would go unnoticed | **Fixed.** postinstall verifies owner, mode and ACL of everything it created and refuses to start the daemon on any deviation; `ctl.sh verify` repeats the report (PASS/FAIL per path). |
| F-NAS-021 | Med | The installer tests ran a source rendering of the scripts, not the scripts in the built PKG | **Fixed.** The tests extract the scripts with `pkgutil --expand-full`; one test proves the package's scripts equal the build's rendering; `PRAXIS_TEST_FROM_SOURCE=1` exists for quick iteration only. |

Second, independent read-only review of the hotfix itself (11 findings, none High; all fixed and tested unless listed under "remaining"):

| Id | Sev | Finding | Status |
|---|---|---|---|
| F-NAS-022 | Med | `restore-state` gated on the BACKUP's age (and failed open when the date could not be parsed): restoring a 30-day-old backup passed although approvals from the last hour were still valid | **Fixed.** The gate is the age of the newest file in the current state, secrets and anchors (unreadable age refuses); backup names must be exactly 14 digits. |
| F-NAS-023 | Med | `restore-state` replaced the anchors with the backup's copy, and the default anchor directory sits in the restored set, so state and anchors rolled back together and the replay protection did not trigger | **Fixed.** Anchors are never restored by the command. **Remaining (documented):** the default sink is owned by the same role account as the state, so it protects against accidental or other-user rollback and against root restoring a backup, not against a compromise of the service account itself; add a second sink on another volume or owner and keep the off-host witness (INSTALL.md step 7). |
| F-NAS-024 | Low | The group/other write test misread modes without owner bits (0070, 0020, 0077 passed) | **Fixed** (mode padded to four digits; tests for 0070, 0020, 0007, 0077). |
| F-NAS-025 | Low | The downgrade gate used `sort -V` and mis-ordered pre-releases; `allow-downgrade` was permanent | **Fixed** (`version_gt`; seven cases; the permission file must be a plain file and is removed by postinstall after success). |
| F-NAS-026 | Low | `--remove-data` deleted logs/run that are not in the archive, trusted tar's exit status, deleted any same-named account and hid failures; a failed `bootout` left a running daemon under the data | **Fixed.** Stop first and verify stopped; the archive is read back before anything is removed; only a provably-ours account is deleted and a failed deletion is reported; the message says the logs are not archived. |
| F-NAS-027 | Low | `rollback` had no path checks, removed the live code before copying (a failed copy left no code) and chose the newest folder even when it held no code | **Fixed.** Chain and leaf checks; the old code is prepared and checked aside, then swapped; the newest backup that really holds code is used. |
| F-NAS-028 | Low | A dangling link or a dotfile link inside `backups/` passed the preinstall check | **Fixed.** |
| F-NAS-029 | Low | Account validation ignored other members of the service's group (nested or by GUID) and treated a failed `dscl -list` as "id unused" | **Fixed.** Any other member refuses; a failed listing refuses. |
| F-NAS-030 | Low | postinstall's payload check ignored empty directories, pipes and sockets; the code tree's owners were not checked; `ctl.sh verify` skipped `ctl.sh` and `MANIFEST.json` | **Fixed.** Exact entry list; every entry must be a plain file or directory owned by root; verify covers all four files. |
| F-NAS-031 | Low | `restore-state` accepted pipes, devices and set-id members, hid a failed `chown`, removed the state before extraction succeeded and did not re-verify permissions | **Fixed.** Only plain files and directories; extraction aside first; failure paths keep the saved state; permissions verified after the swap. |
| F-NAS-032 | Low | Backups were taken from a running service and could be torn | **Fixed.** Upgrade and uninstall stop the daemon first (restarted if the backup fails); `ctl.sh backup` refuses a running service unless `--live` is given. |


## Audit pinning (F-NAS-006)
After every audit append the service writes a **signed** record of the head (sequence, hash, number of consumed approvals)
to `state/anchors/` and to every directory in the root-owned config key `auditAnchorDirs`. At start and before every
execution the chain and ledger are compared with all sinks:

* a chain shorter than an anchor, or a different hash at the anchored sequence → truncation or rollback;
* a ledger with fewer consumptions than an anchor, or an audited consumption missing from the ledger → ledger rollback (replay);
* one sink anchored and another empty or behind → a sink was deleted or restored; a forged anchor → invalid signature;
* an external sink directory that does not exist (an unmounted volume) → refuse; external sinks are created by the owner, never by the service;
* a chain with entries but no anchor in any sink → anchors were removed or the state was restored without them.

The service refuses to start on any of these and refuses to execute if one appears while running (`APPROVAL_INTEGRITY_FAILED`).
`audit-witness` prints a signed head the owner stores **off the machine**; `audit-verify --witness FILE` checks the chain against it.

### What was verified with independent storage, and what was only simulated
| Property | Verified how | Independent storage? |
|---|---|---|
| Truncated tail, whole-state rollback, deleted/forged anchor, rolled-back ledger, mismatch while running, concurrent writers | `service.test.mjs`, sinks in temporary directories | **Simulated**: another directory on the same filesystem, same OS user |
| Rollback of the whole state directory is caught by a sink that is **not** rolled back; unmounting that sink is refused; an empty re-created mount is refused | `service.test.mjs` "REAL separate volume": a sink on a separate APFS disk image (a different device, checked with `stat.dev`) | **Real separate filesystem**, still the same OS user and still writable by the service |
| The off-host witness catches a rollback that rewrote every local sink | `service.test.mjs` "witness", the witness held in memory | **Simulated**: no copy was ever stored off the machine |
| A sink the service identity cannot write to or delete (append-only / another principal) | not tested | **Not verified.** The service must be able to write its sinks, so anchoring cannot protect against a compromised service identity; only the witness (off-host, owner-held) can |
| Anchors that survive a reboot, restore from Time Machine, or an attacker with administrator rights | not tested | **Not verified** |

An attacker who can rewrite the chain, every sink and the signing key together defeats the sinks. That is why the witness exists, and why it only counts if the owner actually stores it elsewhere.

## Areas covered and what was not
Operator page and WebAuthn (XSS, CSRF, Host/Origin, challenge binding and single use, UV, RP ID, replay, enrollment):
`operator-ui.test.mjs`, plus both reviews' reading. Installer: macOS scripts and Linux `install.sh` reviewed by reading; Linux
installer, upgrade, rollback and uninstall executed in a Linux container; macOS scripts only statically checked and the package
inspected; Windows installer and service host **never run**. Executor and Git: tests and both reviews.

Not independently verified: the Windows pieces end to end; macOS under a real separate account; systemd's sandbox directives;
real Touch ID / security keys; Git hosting providers other than the fixture (GitHub is implemented and unexercised).
A third review pass should read the Windows installer, the service host and anything added after this document.
