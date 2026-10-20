#!/bin/sh
# Run by the OWNER as root. Stops the daemon and removes the payload. Keys, ledger and audit are KEPT unless --purge.
set -eu
PRINCIPAL="_praxisapproval"
BASE="/Library/Application Support/Praxis/ApprovalService"
PLIST="/Library/LaunchDaemons/co.praxis.approval-service.plist"
launchctl bootout system "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
rm -rf /usr/local/libexec/praxis-approval-service
if [ "${1:-}" = "--purge" ]; then
  tar -C "$BASE" -czf "$HOME/praxis-approval-backup-$(date +%Y%m%d%H%M%S).tgz" state config.json 2>/dev/null || true
  rm -rf "$BASE" /var/log/praxis-approval
  dscl . -delete "/Users/$PRINCIPAL" 2>/dev/null || true
  dscl . -delete "/Groups/$PRINCIPAL" 2>/dev/null || true
  echo "Removed state and the role account (a backup was written to your home directory)."
else
  echo "Payload removed. State kept in $BASE (use --purge to remove it after a backup)."
fi
