# Installing the Praxis Approval Service

Installing the Desktop extension (`.mcpb`) alone **does not** give OS-level isolation, and `praxis_doctor` will say
`approvalService.reachable: false` / `isolated: false` until this service is installed. The extension works without
it (using the broker inbox of the previous model, which is only as strong as your own separation of identities).

**Praxis tooling never runs the privileged steps below.** They are presented for the owner to review and run. The
agent session that built these artifacts did not create accounts, install daemons, or touch your credentials.

## macOS (Intel and Apple Silicon) — launchd daemon + `.pkg`

What gets installed (all of it root-owned and not writable by your user, so nothing the agent can edit is ever executed):

| Path | Owner / mode | Purpose |
|---|---|---|
| `/usr/local/libexec/praxis-approval-service/` | root:wheel 0755 | own Node runtime, the service bundle, `uninstall.sh` |
| `/Library/LaunchDaemons/co.praxis.approval-service.plist` | root:wheel 0644 | launchd **system daemon** (not a LaunchAgent) running as `_praxisapproval` |
| `/Library/Application Support/Praxis/ApprovalService/config.json` | root:wheel 0644 | repository allow-list, remotes, providers; never overwritten on upgrade |
| `/Library/Application Support/Praxis/ApprovalService/state/` | `_praxisapproval` 0700 | key, ledger, audit chain, operators, requests |
| `/Library/Application Support/Praxis/ApprovalService/run/` | `_praxisapproval` 0755 | the IPC socket |
| `/var/log/praxis-approval/` | `_praxisapproval` 0750 | logs (never tokens or credentials) |
| account `_praxisapproval` | hidden, `/usr/bin/false`, no home, UID/GID from 200–399 | the service's own principal |

### Exact installation plan (for owner approval)

The same steps are available as data: `node tools/approval-service/praxis-approval-service.mjs install-plan --platform darwin`.

1. Build the package (unprivileged; produces an **unsigned** `.pkg`). Supply a self-contained official Node binary for the
   machine's architecture (the Homebrew/nvm Node is refused because it loads libraries from user-writable locations):
   ```
   npm run build
   node tools/approval-service/packaging/build.mjs --variant production --macos-pkg --node /path/to/official/node
   ```
   Output: `dist/approval-service/production/praxis-approval-service-<version>-macos-<arch>.pkg` and `MANIFEST.json`
   (component hashes, Node runtime hash, signing state). Verify the hashes before installing.
2. Review `dist/approval-service/production/macos/postinstall` (what the installer will run as root): create group and
   user `_praxisapproval`, create the directories above, write a default `config.json` only if absent, install the
   plist, `launchctl bootstrap system`. It refuses any volume except `/`.
3. Install (one-time administrator authorization): `sudo installer -pkg <the .pkg> -target /`. Gatekeeper will object to an
   unsigned package; opening it from Finder with the owner's explicit approval is the supported path until a Developer ID
   Installer certificate and notarization exist.
4. Verify as the service identity, then as yourself:
   ```
   sudo -u _praxisapproval "/usr/local/libexec/praxis-approval-service/node/bin/node" /usr/local/libexec/praxis-approval-service/praxis-approval-service.mjs verify-isolation --config "/Library/Application Support/Praxis/ApprovalService/config.json"
   node tools/approval-service/praxis-approval-service.mjs health
   ```
   Expect `verified: true` from the first and `mode: production`, `isolation.verified: true` from the second. Then run
   the isolation acceptance in [ISOLATION-ACCEPTANCE.md](ISOLATION-ACCEPTANCE.md).
5. Allow each repository the service may operate on (an administrator runs what this prints; it grants write on that
   repository's `.git` only):
   ```
   node tools/approval-service/praxis-approval-service.mjs allow-repo /path/to/repo
   ```
   then add the printed entry to `config.json` (root-owned: edit with `sudo`), including the exact remote URLs and the
   branches the service may touch. Restart: `sudo launchctl kickstart -k system/co.praxis.approval-service`.
6. **Credentials the agent must not hold.** For push to be exclusive to the service, give the service its own credential
   (an HTTPS token file or an SSH key readable only by `_praxisapproval`, referenced from `config.json` under
   `credentials`) and remove the user's own push credentials from the agent's reach. Without that, the service cannot
   prevent the agent from pushing with the credentials it already has.
7. Enroll an authenticator (Touch ID or a security key). As the service identity, open a 15 minute window:
   ```
   sudo -u _praxisapproval /usr/local/libexec/praxis-approval-service/node/bin/node /usr/local/libexec/praxis-approval-service/praxis-approval-service.mjs enroll-code --config "/Library/Application Support/Praxis/ApprovalService/config.json"
   ```
   Open `http://localhost:8780/enroll` in Safari or Chrome, type the code, and register the authenticator. The code is
   shown only in your terminal, works once, and expires.
8. Point the Runtime at the service (nothing to configure on macOS: the default endpoint is
   `/Library/Application Support/Praxis/ApprovalService/run/service.sock`; set `PRAXIS_APPROVAL_SERVICE_ENDPOINT` to use another).

### Upgrade, rollback, uninstall

* **Upgrade:** install the newer `.pkg`. The payload is replaced, `config.json` and `state/` are kept, the daemon is restarted.
  The Runtime and service must speak the same protocol (`praxis.approval-service.v1`); `praxis_doctor` reports
  `protocolCompatible`, and a mismatching pair refuses to delegate.
* **Backup before any upgrade or removal:** `sudo tar -C "/Library/Application Support/Praxis/ApprovalService" -czf ~/praxis-approval-backup.tgz state config.json`.
  The keys, ledger and audit chain are the only record of past approvals.
* **Rollback:** reinstall the previous `.pkg` (its hashes are in its `MANIFEST.json`); restore `state/` from the backup
  only if it was damaged. Do not restore an old ledger over a newer one: that would make consumed approvals usable again.
* **Uninstall:** `sudo /usr/local/libexec/praxis-approval-service/uninstall.sh` removes the daemon and payload and keeps
  the state. Add `--purge` to also back up and delete state, logs and the role account.

### Migrating from a manual broker setup (Docker or terminal broker)

1. Keep the old broker's key directory untouched until the new service works. The service generates its **own** key; old
   tokens are not valid and do not need to be.
2. Stop the manual broker processes and any Docker container that mounted its directories. A Docker control socket
   reachable by the agent defeats isolation; the service's probe reports it (`no-docker-control`).
3. Remove `PRAXIS_BROKER_SHARED_DIR`, `PRAXIS_APPROVAL_*` and `PRAXIS_OPERATOR_URL` from the agent's environment; they
   are not used by the service path.
4. Install as above, enroll an authenticator on the new operator page, re-run the isolation acceptance.

## Linux (systemd) — UNTESTED

`node tools/approval-service/praxis-approval-service.mjs render-unit --platform linux` prints a hardened unit
(`User=praxis-approval`, `NoNewPrivileges`, `ProtectSystem=strict`, `StateDirectory` 0700); `install-plan --platform linux`
lists the steps (system user, payload under `/opt/praxis-approval-service`, `/etc/praxis-approval/config.json`, enable the
unit). Not built or run on Linux. Per-repository write access is added with `ReadWritePaths=` and an ACL. Options:
a `.deb`/`.rpm` or the generated script; neither exists yet.

## Windows — UNTESTED

`render-unit --platform win32` prints the service registration script and `install-plan --platform win32` the ACL steps.
The pipe ACL, a service wrapper (WinSW/NSSM) and an isolation probe are not implemented; a production service reports
unverified isolation there and would refuse to start. Windows Hello works through the same WebAuthn page once the rest exists.
