# macOS acceptance of the installed Approval Service (Apple Silicon)

Goal: install the real service under its own macOS account and check, with a real Touch ID, that the AI agent cannot approve,
read its secrets, replace its code or reuse an approval. A green test suite is not this. Nothing here is automatic: every
`sudo` step is yours, and `acceptance.sh` itself never uses sudo.

* Use **only** the throwaway repository `~/praxis-acceptance` (created by `setup-repo`). No production repository, remote,
  credential or Jira is involved. The remote is a bare repository on this disk.
* "You" below means the ordinary user the AI agent runs as. Record the real output of every step in
  `MACOS-ACCEPTANCE-RESULTS.md` (date, macOS version, package sha256, result per step). Do not paste keys or tokens.
* Helper: `ACC="tools/approval-service/acceptance/macos/acceptance.sh"` (run from the praxis-core checkout, as yourself).

## 0. Before installing (as yourself, no sudo)
1. Check the package against `SHA256SUMS` in the release folder and against the build manifest (see INSTALL-MACOS.md).
2. `pkgutil --check-signature <pkg>` says "no signature": expected, the package is unsigned. macOS will warn when you open it;
   that warning is why you checked the hash first.
3. `$ACC setup-repo` (creates the test repository and bare remote).

## Install (administrator) — see INSTALL-MACOS.md for the exact commands
`sudo installer -pkg <pkg> -target /` then `sudo "/Library/Application Support/Praxis/ApprovalService/code/ctl.sh" health`.
Then allow the test repository:
`node tools/approval-service/praxis-approval-service.mjs allow-repo ~/praxis-acceptance/repo --remote ~/praxis-acceptance/remote.git`
(follow its two steps: edit `config.json` with sudo, add the inheritable ACLs), and restart:
`sudo launchctl kickstart -k system/co.praxis.approval-service`.
Use `"branches": ["acceptance/*"]` for the test repository so the service may only touch that branch family.

## A. Separate OS identity
`$ACC a-identity` (plus the three administrator commands it prints).
Expected: the service process and its socket belong to `_praxisapproval`; the account has `/usr/bin/false`, hidden, no home, no
password, a UID of its own; `id _praxisapproval` lists no `admin` group; `client assess` says `isolated: true` and `health` says
`mode: production`, `isolation.verified: true`. **Fail** if the process runs as you or as root.

## B. The agent cannot reach keys, credentials, audit, ledger, code or the process
`$ACC b-denials`. Every line must be `PASS` (each is a command that has to be *denied*): signing key, state listing, audit append,
ledger write, enrollment file, token planting, configuration, service script, bundled Node, launchd plist, socket removal and
rename, signalling the process, backups, logs; and the IPC refuses `approve` as `UNKNOWN_OPERATION`.
Also try by hand anything you think of that the script does not, and note it.

## C. Docker cannot be used to obtain the Broker's authority
`$ACC c-docker` (Docker Desktop running). On macOS, Docker bind mounts act with **your** identity and only see folders shared
with the VM, so the expectation is that the service's directories are not readable through it, and a privileged container sees
only the Docker VM. This is expected, not guaranteed: **observe and record the real output**. If any container prints a key, the
installation is not independent: stop and report. Through the socket Docker reaches only what you can: IPC, which has no approval.

## D. Real Touch ID enrollment
`$ACC d-enroll` prints the exact commands. Open `http://localhost:8780/enroll` in Safari or Chrome on this Mac, type the code, and
use Touch ID. Expected: "Enrolled", enrollment closed, `health` shows `enrolledAuthenticators: 1`. Check that the code cannot be
reused and that a wrong code five times locks it. The service accepts the authenticator without attestation, so it does **not**
claim hardware backing; write down in the results that it was Touch ID because *you* saw the prompt.

## E. REJECT with no Git change
`$ACC submit-commit 1`, open the printed URL. Check the page shows the work item, the repository, the branch
`acceptance/touch-id`, the file `accept-1.txt`, the commit message, the fingerprint, the expiry, and that it is reversible until pushed.
Press **Reject** (Touch ID). `$ACC execute 1` must print `APPROVAL_REJECTED`; `git -C ~/praxis-acceptance/repo log` and `status`
must be unchanged (the file untracked, nothing staged, no new branch).

## F. APPROVE one local commit
`$ACC submit-commit 2`, **Approve** with Touch ID, `$ACC execute 2`. Expected: `state: completed`, exactly one new commit authored
by "Praxis Approval Service" containing only `accept-2.txt` on a new branch `acceptance/touch-id`; your working tree and index are
otherwise untouched.

## G. Replay, modified plan, expired approval
* Replay: `$ACC g-replay 2` — same execution id returns the recorded commit, no second commit; a different message with the same id
  is `CHANGED_PLAN`. Run `execute 2` again: the recorded result, no new commit.
* Modified plan: `$ACC g-modified` (approve a request, change the file, execute): `APPROVAL_SCOPE_MISMATCH`, no commit.
* Expired: `$ACC g-expired` (a short `planTtlMs` in the root-owned configuration; remove it afterwards).

## H. No approval branches or secrets in the repository
`$ACC h-clean`: no approval-looking refs, files or key text anywhere in history; only `main` and `acceptance/touch-id` exist.

## I. After a reboot
`$ACC i-reboot` prints the steps. The service must be running without anyone logging in (LaunchDaemon), `ctl.sh health` must pass
and the recorded commit must still be returned for execution id `ex-accept-2` (ledger and audit survived).

## J. Rollback and removal
`$ACC j-rollback` prints the steps: `ctl.sh verify` (every line PASS), `backup`, `rollback` (CODE only; afterwards `g-replay 1` must still return the recorded commit), `health`, `uninstall` (state kept), `uninstall --remove-data` (account gone: `dscl . -read /Users/_praxisapproval` must fail), and, only if you want it, `uninstall --delete-everything praxis-delete-all-data`.
Backups live in `/Library/Application Support/Praxis/ApprovalService/backups` (root only) and remain after `--remove-data`.

## Result
The installation is accepted only if A, B, D, E, F, G, H pass and C was observed and recorded. I and J complete the lifecycle.
Anything that fails goes into the Work Item as a finding; do not weaken a check to make it pass.

### What this plan does not cover
Windows and Linux hosts; a hardware security key (FIDO2) other than Touch ID; real Git hosting (push to a remote with credentials is not
part of this plan: the remote is a local bare repository); the Desktop extension (see INSTALL-MACOS.md for how to point it at the
service, which needs no configuration on macOS).
