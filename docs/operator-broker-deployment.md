# Operator guide: running the approval broker as a separate identity

Status: **procedure written, not executed**. It needs `sudo`, which the development agent does not have. Nothing here has been verified on a real second OS identity or with a hardware authenticator. Until you run it and `praxis_doctor` agrees, Desktop Praxis stays in secure mode and refuses protected writes.

## Why
The agent runs as you. Anything you can write, it can write: the broker's key, ledger and the extension settings. An approval is only meaningful if the broker's files and process belong to someone else, and the agent cannot start Docker to reach them.

## macOS steps (you run these)
```bash
# 1. a service account that cannot log in
sudo sysadminctl -addUser praxisbroker -shell /usr/bin/false -home /var/empty -password -
# 2. broker home, owned by that account
sudo mkdir -p /usr/local/var/praxis-broker/{keys,ledger,shared/{pending,authorizations,approved,rejected}}
sudo chown -R praxisbroker /usr/local/var/praxis-broker
sudo chmod 700 /usr/local/var/praxis-broker/keys /usr/local/var/praxis-broker/ledger
sudo chmod 755 /usr/local/var/praxis-broker /usr/local/var/praxis-broker/shared
# the agent side may only ADD plans to pending/
sudo chmod 1777 /usr/local/var/praxis-broker/shared/pending
# 3. run the broker as the service account (see the broker's --help for key generation flags)
sudo -u praxisbroker node /path/to/praxis-core/tools/broker/praxis-broker.mjs --help
```
Then start `serve-operator-web --enroll` as `praxisbroker` (the enrollment secret prints in that terminal only), open the printed URL in a browser, and enroll Touch ID or a security key. Copy only the PUBLIC key where Desktop can read it. Set the extension settings: broker shared folder, trust anchor (public key), ledger path, operator URL.

## Verify
1. `praxis_doctor` → `security`: broker found, trust anchor not writable by you, ledger not writable, no `docker-control` finding.
2. An unsigned `praxis_workflow_apply` is refused.
3. A Story confirmation shows the operator page; approving there lets `confirm-story` proceed once; replay is refused.

## Known limits
- Docker reachable by your user = BLOCKED, whatever the broker does. Remove your user's Docker access or use a remote broker.
- Enrollment is trust-on-first-use; attestation is recorded, not verified.
- The executor is fixture-only: no production Jira/Git writes exist.

## Rollback
Clear the new extension settings, remove the account (`sudo sysadminctl -deleteUser praxisbroker`) and `/usr/local/var/praxis-broker`. Reinstall the previous `.mcpb` from your backup.
