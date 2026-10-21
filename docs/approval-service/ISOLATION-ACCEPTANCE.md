# Isolation acceptance — tests that need the installed service

Linux has already run an equivalent of sections A and B (and the approve/reject/replay flow) in a container with real uid separation: `npm run accept:approval-service-linux`, LINUX-CONTAINER PASS 44/44. That is not a substitute for running them on the installed macOS service or on Windows. Everything below is **OS-ISOLATION BLOCKED / HUMAN-APPROVAL BLOCKED pending operator**: it needs the owner to install the service (one-time administrator
authorization) and, for the last section, to be present with an authenticator. None of it ran in the development
session, and no simulated test substitutes for it. Run these as the agent's own user (the one Claude runs as), on the
machine where the service is installed.

Record the outcome of each in `ISOLATION-RESULTS.md` next to this file (date, macOS version, service version, pass/fail).

## A. Independent OS identity (scenarios 11, 12, 13, 17)

| # | Command (run as the agent's user) | Expected |
|---|---|---|
| A1 | `cat "/Library/Application Support/Praxis/ApprovalService/state/trusted/private.pem"` | `Permission denied` |
| A2 | `ls "/Library/Application Support/Praxis/ApprovalService/state"` | `Permission denied` |
| A3 | `echo x >> "/Library/Application Support/Praxis/ApprovalService/state/audit/chain.jsonl"` | `Permission denied` |
| A4 | `echo x > "/Library/Application Support/Praxis/ApprovalService/config.json"` | `Permission denied` |
| A5 | `echo x > "/Library/Application Support/Praxis/ApprovalService/code/praxis-approval-service.mjs"` | `Permission denied` |
| A6 | `echo x > "/Library/Application Support/Praxis/ApprovalService/run/service.sock"`; `rm "/Library/Application Support/Praxis/ApprovalService/run/service.sock"` | cannot remove or replace the socket (directory is not writable by you) |
| A7 | `ps -o user= -p $(pgrep -f praxis-approval-service.mjs)` | `_praxisapproval` |
| A8 | `kill $(pgrep -f praxis-approval-service.mjs)` | `Operation not permitted` |
| A9 | `node tools/approval-service/praxis-approval-service.mjs health` | `mode: production`, `isolation.verified: true` |
| A10 | From the Runtime: `praxis_doctor` | `approvalService.isolated: true` |
| A11 | Start a fake service on a different path as yourself that answers `health` with `production` and `verified: true`; point `PRAXIS_APPROVAL_SERVICE_ENDPOINT` at it | `praxis_doctor` reports `isolated: false` (endpoint owned by your user) |
| A12 | `printf '{"protocol":"praxis.approval-service.v1","op":"approve","requestId":"x"}\n' \| nc -U "/Library/Application Support/Praxis/ApprovalService/run/service.sock"` | `UNKNOWN_OPERATION` |
| A13 | Docker: if Docker Desktop is installed and your user can control it, try to start a container that bind-mounts `/Library/Application Support/Praxis` | the mount is not readable by the container's host-side identity either, or the service's probe already reports `no-docker-control` failed. Record the real result; the Docker VM is a separate trust domain and this must be observed, not assumed. |
| A14 | Stop the service (`sudo launchctl bootout system/co.praxis.approval-service`) then ask the Runtime for a commit | `APPROVAL_ISOLATION_UNAVAILABLE`, nothing committed |

## B. Executor and credentials

| # | Check | Expected |
|---|---|---|
| B1 | As yourself, with the push credential removed from your environment, `git push` to the allow-listed remote | rejected by the remote |
| B2 | Request a push through the Runtime, approve it, execute | the remote branch equals the approved commit; your user's credentials were not used (service credential only) |
| B3 | `git -C <repo> config core.hooksPath /tmp/x`, then request a commit | `REPOSITORY_UNSAFE` |
| B4 | Replace a staged/named file between approval and execution | `APPROVAL_SCOPE_MISMATCH`, no commit |

## C. Real human approval (needs the operator present)

1. Enroll Touch ID (Safari/Chrome on this Mac) or a FIDO2 key via the enrollment code (see INSTALL.md step 7).
2. Ask the Runtime for a commit; the response contains an operator URL. Open it. Confirm the page shows work item,
   repository, action, exact files with hashes, branch and revision, remote, fingerprint, expiry, risks, reversibility.
3. Press **Reject**: nothing changes. Request again, press **Approve**, complete the Touch ID / key prompt. Execute.
   Verify exactly one new commit.
4. Try to reuse the same approval for a different request: refused.
5. Note in the results whether the authenticator was platform (Touch ID) or roaming (security key). The service enrolls
   with `attestation: none`, so hardware backing is **not** verified; record only what you observed.

Windows Hello and Linux passkeys/FIDO2 are not exercised by any of this.

## D. Windows (UNTESTED; needs the owner and a Windows machine)

Run `install.ps1 -Check`, `-Install`, `-Health`. Then as an ordinary (non-administrator) user: read `C:\ProgramData\Praxis\ApprovalService\state\trusted\private.pem`
(expect access denied), write to the code directory and to `config.json` (denied), `Get-Acl \\.\pipe\praxis-approval-service` (expect a DENY for
NT AUTHORITY\NETWORK and no write-DAC for you), stop the service (denied), and connect to the pipe from a second user. Record the real result of each.
