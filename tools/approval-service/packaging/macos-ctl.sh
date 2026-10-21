#!/bin/sh
# Service management for the OWNER, run as root:  ctl.sh health | backup | rollback | uninstall [--purge]
set -eu
PRINCIPAL="_praxisapproval"
BASE="/Library/Application Support/Praxis/ApprovalService"
CODE="$BASE/code"
BACKUPS="$BASE/backups"
PLIST="/Library/LaunchDaemons/co.praxis.approval-service.plist"
ENDPOINT="$BASE/run/service.sock"
die() { echo "praxis-approval-service: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "run as root"; }

backup() {
  need_root
  umask 077
  mkdir -p "$BACKUPS"; chown root:wheel "$BACKUPS"; chmod 0700 "$BACKUPS"
  DEST="$BACKUPS/$(date +%Y%m%d%H%M%S)"
  mkdir "$DEST"
  ITEMS=""
  [ -d "$BASE/state" ] && ITEMS="state"
  [ -f "$BASE/config.json" ] && ITEMS="$ITEMS config.json"
  if [ -n "$ITEMS" ]; then
    # shellcheck disable=SC2086
    tar -C "$BASE" -czf "$DEST/state-and-config.tgz" $ITEMS || die "backup failed; nothing was changed"
  fi
  cp -R "$CODE" "$DEST/code"
  echo "backup: $DEST"
}

case "${1:-}" in
  health)
    OUT="$("$CODE/node/bin/node" "$CODE/praxis-approval-service.mjs" health --endpoint "$ENDPOINT")" || die "the service does not answer on $ENDPOINT"
    echo "$OUT"
    echo "$OUT" | grep -q '"mode": *"production"' || die "not in production mode"
    echo "$OUT" | tr -d '\n ' | grep -q '"isolation":{"verified":true' || die "isolation is not verified"
    echo "$OUT" | tr -d '\n ' | grep -q '"integrity":{"ok":true' || die "integrity problem reported"
    echo healthy ;;
  backup) backup ;;
  rollback)
    need_root
    LAST="$(ls -1 "$BACKUPS" 2>/dev/null | sort | tail -n 1)"
    [ -n "$LAST" ] && [ -d "$BACKUPS/$LAST/code" ] || die "no backup to roll back to"
    launchctl bootout system "$PLIST" 2>/dev/null || true
    rm -rf "$CODE"
    cp -R "$BACKUPS/$LAST/code" "$CODE"
    chown -R root:wheel "$CODE"; chmod -R go-w "$CODE"
    [ "${2:-}" = "--restore-state" ] && { echo "restoring state from $BACKUPS/$LAST (an older ledger makes consumed approvals usable again; the integrity anchors will refuse to start on an older state unless restored with it)"; tar -C "$BASE" -xzf "$BACKUPS/$LAST/state-and-config.tgz"; }
    launchctl bootstrap system "$PLIST"
    echo "rolled back to the code of backup $LAST" ;;
  uninstall)
    need_root
    backup
    launchctl bootout system "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    rm -rf "$CODE"
    if [ "${2:-}" = "--purge" ]; then
      rm -rf "$BASE/state" "$BASE/config.json" "$BASE/run" /var/log/praxis-approval
      dscl . -delete "/Users/$PRINCIPAL" 2>/dev/null || true
      dscl . -delete "/Groups/$PRINCIPAL" 2>/dev/null || true
      echo "Removed state, configuration and the role account. Backups remain in $BACKUPS (root only)."
    else
      echo "Removed the daemon and code. State, configuration and backups remain in $BASE (use --purge to remove state)."
    fi ;;
  *) echo "usage: ctl.sh health|backup|rollback [--restore-state]|uninstall [--purge]" >&2; exit 2 ;;
esac
