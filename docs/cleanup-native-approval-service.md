# Removing the native Approval Service from a Mac

Praxis no longer has a native Approval Service, an OS broker, a LaunchDaemon, a `_praxisapproval` account, WebAuthn enrollment or a `.pkg` installer. Approvals are given by you in the MCP client (`docs/user-approval.md`).

Nothing in the repositories installs, uses or needs any of this, and **no Praxis tool runs anything below**: these are the commands for you to run, one at a time, only if you started installing the service on your Mac. Every `sudo` line is yours to read first. Read each check before the removal that follows it.

Where the first installation attempt stopped (account check refused a correct account), the installer may have left: the account and group `_praxisapproval` (UID/GID in the 200s), the unpacked files under `/Library/Application Support/Praxis/ApprovalService`, the log directory, a package receipt, the staging copy of the package and possibly a LaunchDaemon plist. The service was **not** registered with launchd in that run, so there is normally no process to stop.

## 1. See what is there (no changes)

```bash
launchctl print system/co.praxis.approval-service 2>&1 | head -3
```
`Could not find service` means it is not loaded.

```bash
ls -la "/Library/LaunchDaemons/co.praxis.approval-service.plist" "/Library/Application Support/Praxis" "/private/var/log/praxis-approval" /private/var/root/praxis-staging 2>&1
```

```bash
dscl . -read /Users/_praxisapproval UniqueID PrimaryGroupID UserShell IsHidden 2>&1; dscl . -read /Groups/_praxisapproval PrimaryGroupID 2>&1
```

```bash
pkgutil --pkgs | grep -i praxis
```
The receipt identifier is `co.praxis.approval-service`.

## 2. Keep anything you might want (optional)

The state directory holds a signing key, operator enrollments and an approval ledger that nothing uses any more. If you want a record of them before they are deleted, make a root-only copy:

```bash
sudo tar -C "/Library/Application Support/Praxis" -czf "$HOME/praxis-approval-service-backup.tgz" ApprovalService && sudo chown "$USER" "$HOME/praxis-approval-service-backup.tgz" && chmod 600 "$HOME/praxis-approval-service-backup.tgz"
```
It contains a private key: store it somewhere safe or delete it when you no longer need it.

## 3. Stop it, if it was ever loaded

```bash
sudo launchctl bootout system "/Library/LaunchDaemons/co.praxis.approval-service.plist"
```
Fails harmlessly with `No such process` when it is not loaded.

## 4. Remove the files

```bash
sudo rm -f "/Library/LaunchDaemons/co.praxis.approval-service.plist"
```

```bash
sudo rm -rf "/Library/Application Support/Praxis/ApprovalService"
```

```bash
sudo rm -rf "/private/var/log/praxis-approval"
```

The parent folder `/Library/Application Support/Praxis` belongs to the service only. Remove it if it is now empty:

```bash
sudo rmdir "/Library/Application Support/Praxis" 2>&1
```

The staged copy of the package and your unpacked inspection copy:

```bash
sudo rm -rf /private/var/root/praxis-staging /tmp/praxis-pkg-inspect
```

## 5. Remove the service account

Only the account `_praxisapproval` that you saw in step 1 with a shell of `/usr/bin/false`:

```bash
sudo dscl . -delete /Users/_praxisapproval
```

```bash
sudo dscl . -delete /Groups/_praxisapproval
```

## 6. Forget the package receipt

```bash
sudo pkgutil --forget co.praxis.approval-service
```

## 7. Check that nothing is left

```bash
dscl . -read /Users/_praxisapproval 2>&1 | head -1; dscl . -read /Groups/_praxisapproval 2>&1 | head -1
```
Both must say the record was not found (`eDSRecordNotFound`).

```bash
ls "/Library/LaunchDaemons" | grep -i praxis; ls "/Library/Application Support" | grep -i praxis; ls /private/var/log | grep -i praxis; pkgutil --pkgs | grep -i praxis
```
Nothing should be printed.

## 8. Settings that no longer exist

- The Claude Desktop extension settings *Security mode*, *Approval broker shared folder*, *Approval trust anchor*, *Approval ledger path* and *Operator approval page URL* are gone. The only approval setting is *Require approval in the client dialog* (optional). Extension values you entered earlier are ignored.
- Environment variables `PRAXIS_SECURITY_MODE`, `PRAXIS_BROKER_*`, `PRAXIS_APPROVAL_SERVICE_ENDPOINT`, `PRAXIS_APPROVAL_PUBLIC_KEY*`, `PRAXIS_APPROVAL_LEDGER`, `PRAXIS_OPERATOR_URL` are no longer read. Remove them from your shell profile and from any `.env` you wrote.
- Any browser bookmark for `http://localhost:8780` (the old operator page) can go; nothing listens there now.
- The repository folder `.praxis/approvals/` can hold files from the old stored-approval flow (for example `harness-*.json`) or from the first version of the decision log (`decisions.jsonl`); they authorize nothing and can be deleted. The decision journal now lives outside the repository, in `~/.praxis/decisions/`.
