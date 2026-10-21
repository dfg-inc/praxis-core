# Installing the Praxis Approval Service

Installing the Desktop extension (`.mcpb`) alone **does not** give OS-level isolation, and `praxis_doctor` reports
`approvalService.reachable: false` / `isolated: false` until this service is installed.

**Praxis tooling never runs the privileged steps below.** They are presented for the owner to review and run. The session that
built these artifacts did not create accounts, install services, or touch credentials or SSH configuration.

Every platform package has: compatibility checks (architecture, OS version, package checksums, bundled runtime, downgrade),
install, upgrade, backup, rollback, health check, and (macOS) three separate removal levels: uninstall (state kept), `--remove-data` (live data removed after a root-only recovery archive) and `--delete-everything` (backups too, exact phrase required). Linux and Windows keep their `uninstall [--purge]`.

## macOS (Intel and Apple Silicon) — launchd daemon + `.pkg`   [OS-ISOLATION BLOCKED pending operator]

| Path | Owner / mode | Purpose |
|---|---|---|
| `/Library/Application Support/Praxis/ApprovalService/code/` | root:wheel, no group/other write | bundled Node, service bundle, `ctl.sh`, `MANIFEST.json` |
| `/Library/LaunchDaemons/co.praxis.approval-service.plist` | root:wheel 0644 | launchd **system daemon** (not a LaunchAgent) as `_praxisapproval` |
| `…/ApprovalService/config.json` | root:wheel 0644 | PUBLIC settings only: repository allow-list, remotes, branches, providers, `auditAnchorDirs`; never overwritten. Inline secrets and unknown keys are refused |
| `…/ApprovalService/secrets/` | `_praxisapproval` 0700 | credential files (token, SSH key) named from `config.json`; each file must be owned by the service and 0600 |
| `…/ApprovalService/anchors/` | `_praxisapproval` 0700 | external audit-anchor sink (outside `state/`), required in production |
| `…/ApprovalService/state/` | `_praxisapproval` 0700 | key, ledger, audit, anchors, operators, requests |
| `…/ApprovalService/run/` | `_praxisapproval` 0755 | the IPC socket |
| `…/ApprovalService/backups/` | root 0700 | automatic backups taken by every upgrade and uninstall |
| `/private/var/log/praxis-approval/` | `_praxisapproval` 0750 | logs (never tokens or credentials) |

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
2. **Review** `dist/approval-service/production/macos/{preinstall,postinstall,ctl.sh}` (the same text is inside the package: `pkgutil --expand-full`).
   preinstall runs BEFORE any file is extracted and, on any of the following, stops the installation having changed nothing:
   another architecture, macOS older than 12, no Command Line Tools git, a target volume other than the boot volume; on every
   existing ancestor and location (installation, code, state, run, secrets, anchors, backups, the log directory and its parent,
   `/Library/LaunchDaemons` and the plist destination) a symbolic link (a dangling one included), an owner other than root (the
   service's own directories may be owned by `_praxisapproval`), a group/other write bit, or an ACL entry that grants anyone
   write-like access; a code tree or backup with links, group/other-writable or set-id entries or write ACLs; an existing
   `_praxisapproval` that is not provably this installer's (RealName, UID and GID unique in 1–499, GID = UID, group id agrees, shell
   `/usr/bin/false`, home `/var/empty`, hidden, no password, no authentication authority, no admin or other group membership; an
   interrupted installation that left only a group or only some attributes is completed, never replaced); and a downgrade (unless you
   create `…/allow-downgrade`). It then takes a root-only backup of any existing code, state, configuration, secrets and anchors (a
   failed backup stops the installation; the daemon is stopped first so the snapshot is consistent and is restarted if the backup fails; backups are never deleted automatically).
   postinstall re-checks the extracted payload (exactly four files, no links, nothing writable), creates or completes the account,
   creates the directories, keeps an existing `config.json`, sets and then **verifies** every owner and mode, and starts the daemon
   only if all of them are right. `ctl.sh verify` repeats that report at any time.
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

Upgrade: install the newer `.pkg` (backup is automatic). Four separate things, none implied by another:
- **Rollback** (`sudo …/code/ctl.sh rollback`): the previous CODE only. State, ledger, audit chain, anchors and keys are untouched, so an
  approval that was already used stays used.
- **Restore state** (`sudo …/code/ctl.sh restore-state <backup>`): disaster recovery for LOST or damaged state only. Refused while the
  service runs and unless nothing in the CURRENT state, secrets or anchors changed in the last 25 hours (so every approval that could
  still be valid has expired; the age of the backup itself proves nothing). The archive is checked (only `state`, `secrets`,
  `anchors`, `config.json`; no links, devices or pipes), the current state is saved first, the old state is unpacked aside and swapped
  in, permissions are verified. **The anchors are not restored**: they are the independent record, and an older ledger makes consumed
  approvals look unused, so the service refuses to start when an anchor is newer than the restored state. That refusal is the protection
  working; resolving it (restoring the anchors too, after you have decided the old state is right) is a separate, deliberate act.
- **Uninstall** (`uninstall`): daemon and code go; state, configuration, secrets, anchors, backups and the account stay.
- **Remove data** (`uninstall --remove-data`): also live data and the account, after a recovery archive in `backups/`. **Delete everything**
  (`uninstall --delete-everything praxis-delete-all-data`): also the backups. Nothing deletes data unless you type one of these.

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
