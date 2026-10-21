# Installing the Praxis Approval Service

Installing the Desktop extension (`.mcpb`) alone **does not** give OS-level isolation, and `praxis_doctor` reports
`approvalService.reachable: false` / `isolated: false` until this service is installed.

**Praxis tooling never runs the privileged steps below.** They are presented for the owner to review and run. The session that
built these artifacts did not create accounts, install services, or touch credentials or SSH configuration.

Every platform package has: compatibility checks (architecture, OS version, package checksums, bundled runtime, downgrade),
install, upgrade, backup, rollback, health check, uninstall (state kept) and purge (state removed after a root-only backup).

## macOS (Intel and Apple Silicon) — launchd daemon + `.pkg`   [OS-ISOLATION BLOCKED pending operator]

| Path | Owner / mode | Purpose |
|---|---|---|
| `/Library/Application Support/Praxis/ApprovalService/code/` | root:wheel, no group/other write | bundled Node, service bundle, `ctl.sh`, `MANIFEST.json` |
| `/Library/LaunchDaemons/co.praxis.approval-service.plist` | root:wheel 0644 | launchd **system daemon** (not a LaunchAgent) as `_praxisapproval` |
| `…/ApprovalService/config.json` | root:wheel 0644 | repository allow-list, remotes, branches, providers; never overwritten |
| `…/ApprovalService/state/` | `_praxisapproval` 0700 | key, ledger, audit, anchors, operators, requests |
| `…/ApprovalService/run/` | `_praxisapproval` 0755 | the IPC socket |
| `…/ApprovalService/backups/` | root 0700 | automatic backups taken by every upgrade and uninstall |
| `/var/log/praxis-approval/` | `_praxisapproval` 0750 | logs (never tokens or credentials) |

The account `_praxisapproval` is hidden, has `/usr/bin/false`, no home and no password, and a UID/GID that is free in both
directories (200–399).

1. **Build** (unprivileged, produces an unsigned package) from the **official** Node.js archive for the machine's architecture
   and its published checksum file (download both from nodejs.org yourself or use the release folder's copies):
   `node tools/approval-service/packaging/build.mjs --variant production --macos-pkg --node-tarball node-v24.22.1-darwin-arm64.tar.gz --node-shasums SHASUMS256.txt --node-source-url https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz`
   The build refuses unless the archive's SHA-256 equals its line in the checksum file, the binary is a Mach-O of the package's
   architecture, links only system libraries (never Homebrew or nvm), carries a valid Developer ID signature of the Node.js
   Foundation (team HX7739G8FX) and runs. Build once per architecture. `MANIFEST.json` records the version, source, archive and
   checksum-file hashes and the signer. The release folder (`release/macos-approval-service-<version>/`) contains the finished package, so
   most owners skip this step and just verify `SHA256SUMS`.
2. **Review** `dist/approval-service/production/macos/{preinstall,postinstall,ctl.sh}`. preinstall: refuses another architecture,
   macOS older than 12, a linked or non-root base directory, and a downgrade (unless you create `…/allow-downgrade`), then takes a
   root-only backup of any existing code, state and configuration (a failed backup stops the installation).
   postinstall: verifies every ancestor of the code directory is root-owned and not group/other-writable, creates the account and
   directories, keeps an existing `config.json`, starts the daemon.
3. **Install** (one-time administrator authorization): `sudo installer -pkg <the .pkg> -target /`. An unsigned package is stopped
   by Gatekeeper until you approve it; a Developer ID Installer certificate and notarization do not exist yet.
4. **Check**: `sudo "/Library/Application Support/Praxis/ApprovalService/code/ctl.sh" health` (production mode, isolation
   verified, integrity ok) and `node tools/approval-service/praxis-approval-service.mjs health`. Then run
   [ISOLATION-ACCEPTANCE.md](ISOLATION-ACCEPTANCE.md).
5. **Allow each repository**: `node tools/approval-service/praxis-approval-service.mjs allow-repo /path/to/repo` prints the
   inheritable ACL step (so files each side creates stay writable by the other) and the `config.json` entry (path, exact remote
   URLs, `branches` — a repository without `branches` allows none). Edit `config.json` with `sudo`; restart:
   `sudo launchctl kickstart -k system/co.praxis.approval-service`.
6. **Credentials the agent must not hold.** Give the service its own token file or SSH key (readable only by `_praxisapproval`;
   a file readable by group/others is refused) under `credentials` in `config.json`, and remove the user's own push credentials
   from the agent's reach. Otherwise the service cannot stop the agent from pushing with what it already has.
7. **Pin the audit log**: add a second directory on a different protected location to `auditAnchorDirs`, and keep an off-host
   witness: `sudo -u _praxisapproval … audit-witness --config …` (store the output elsewhere; check later with
   `audit-verify --witness FILE`).
8. **Enroll** Touch ID or a security key: `sudo -u _praxisapproval "…/code/node/bin/node" "…/code/praxis-approval-service.mjs" enroll-code --config "…/config.json"`,
   then open `http://localhost:8780/enroll` and type the code (single use, 80 bits, expires in 15 minutes, locked after five misses).

Upgrade: install the newer `.pkg` (backup is automatic). Rollback: `sudo …/code/ctl.sh rollback` (`--restore-state` also
restores state; an older ledger makes consumed approvals usable again and the integrity anchors will refuse it unless restored
together). Uninstall: `sudo …/code/ctl.sh uninstall` (keeps state) or `uninstall --purge` (backup first, root-only).

### Migrating from a manual broker setup (Docker or terminal broker)
Keep the old broker's keys until the new service works; the service generates its own key (old tokens are not valid). Stop the
manual broker and any container that mounted its directories (a Docker control socket reachable by the agent defeats isolation;
the probe reports `no-docker-control`). Remove `PRAXIS_BROKER_*`, `PRAXIS_APPROVAL_*` and `PRAXIS_OPERATOR_URL` from the agent's
environment (the service path does not use them, and a repository `.env` cannot set them). Install, enroll, re-run the acceptance.

## Linux (systemd) — `.tar.gz`   [LINUX-CONTAINER PASS; systemd UNTESTED]

Build (needs Docker and a Linux Node; the script takes the official binary from the image): see `npm run accept:approval-service-linux`,
or directly `build.mjs --variant production --linux-tar --linux-node <node> --linux-arch arm64|x64 --linux-node-version vX.Y.Z`.
Then, as root: `tar -xzf praxis-approval-service-<version>-linux-<arch>.tar.gz && cd praxis-approval-service-<version>-linux-<arch>`
and `sh install.sh check` (changes nothing), `sh install.sh install`, `/opt/praxis-approval-service/current/ctl.sh health`.
Layout: `/opt/praxis-approval-service/<version>/` (root-owned, `current` link switched atomically, previous kept for rollback),
`/etc/praxis-approval/config.json` (root, never overwritten), `/var/lib/praxis-approval` (0700, `praxis-approval` system user),
`/var/backups/praxis-approval` (root 0700). Commands: `install`, `upgrade [--allow-downgrade]`, `backup`, `rollback [--restore-state F]`,
`health`, `uninstall [--purge]`, `--dry-run`. Per-repository access: `setfacl -R -m u:praxis-approval:rwX -d -m u:praxis-approval:rwX <repo>/.git`
(plus `systemctl edit praxis-approval` → `ReadWritePaths=<repo>`). The unit sandboxes the service (`ProtectSystem=strict`,
`NoNewPrivileges`, empty capability set, syscall filter, `RestrictAddressFamilies`, …); it has not been run under systemd.

## Windows 10/11 — zip   [UNTESTED]

`install.ps1` (elevated) with `-Check`, `-Install`/`-Upgrade`, `-Backup`, `-Rollback`, `-Health`, `-EnrollCode`, `-Uninstall [-Purge]`.
It compiles a small service host with the OS-provided C# compiler (node.exe is not a service host), registers the service under the
virtual account `NT SERVICE\PraxisApproval`, sets ACLs with `icacls` (state: service modify only; code: Administrators/SYSTEM write
only), and the host sets the named pipe's DACL (SYSTEM, Administrators and the service full; Authenticated Users read/write; NETWORK
denied). **None of this has ever run on Windows.** Do not rely on it until the `windows` CI job and your own acceptance have passed.
No Windows Node was available to build a package; the zip builder exists and is tested only with a stand-in file.
