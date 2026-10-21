#!/bin/sh
# Service management for the OWNER, run as root:
#   ctl.sh health                         production mode, verified isolation, integrity ok (read-only)
#   ctl.sh verify                         owners, modes and ACLs of everything the installation created (read-only)
#   ctl.sh backup                         root-only backup of state, config, secrets, anchors and code
#   ctl.sh rollback                       previous CODE only; state, ledger, audit and anchors are never touched
#   ctl.sh restore-state <backup>         disaster recovery: put an OLD state back (gated; see below)
#   ctl.sh uninstall                      stop and remove the daemon and the code. KEEPS state, config, secrets, anchors, backups, account
#   ctl.sh uninstall --remove-data        also remove state, config, secrets, anchors and the account, after a recovery archive is written to backups/
#   ctl.sh uninstall --delete-everything praxis-delete-all-data    also delete the backups (cannot be undone)
set -eu
BASE="/Library/Application Support/Praxis/ApprovalService"
CODE="$BASE/code"
BACKUPS="$BASE/backups"
STATE="$BASE/state"
RUN="$BASE/run"
SECRETS="$BASE/secrets"
ANCHORS="$BASE/anchors"
LOGDIR="/private/var/log/praxis-approval"
PLIST="/Library/LaunchDaemons/co.praxis.approval-service.plist"
ENDPOINT="$RUN/service.sock"
DELETE_PHRASE="praxis-delete-all-data"

# @@LIB@@

die() { psec_fail "$@"; }
need_root() { [ "$(id -u)" = 0 ] || die "run as root"; }

# a backup directory name must be one this tool wrote: digits only, a real directory directly inside backups/, not a link
backup_dir_of() {
  name="$1"
  case "$name" in ''|*[!0-9]*) die "'$name' is not a backup name (digits only, as listed in $BACKUPS)" ;; esac
  [ -d "$BACKUPS/$name" ] && [ ! -L "$BACKUPS/$name" ] || die "no such backup: $name"
  echo "$BACKUPS/$name"
}

backup() { # backup [--live]
  need_root
  psec_assert_chain "$(dirname "$BACKUPS")"; psec_assert_leaf "$BASE"
  # a snapshot of a service that is writing could be torn (an inconsistent ledger/audit pair that a later restore would then reproduce)
  if service_running && [ "${1:-}" != "--live" ]; then die "the service is running: stop it first (launchctl bootout system \"$PLIST\") so the backup is consistent, or run 'backup --live' to accept a possibly torn copy"; fi
  umask 077
  mkdir -p "$BACKUPS"; chown root:wheel "$BACKUPS"; chmod 0700 "$BACKUPS"
  DEST="$BACKUPS/$(date +%Y%m%d%H%M%S)"
  mkdir "$DEST"
  ITEMS=""
  for item in state config.json secrets anchors; do [ -e "$BASE/$item" ] && ITEMS="$ITEMS $item"; done
  if [ -n "$ITEMS" ]; then
    # shellcheck disable=SC2086
    tar -C "$BASE" -czf "$DEST/state-and-config.tgz" $ITEMS || die "backup failed; nothing was changed"
    tar -tzf "$DEST/state-and-config.tgz" >/dev/null || die "the backup archive cannot be read back; nothing was changed"
  fi
  cp -R "$CODE" "$DEST/code" || die "backup of the code failed; nothing was changed"
  echo "backup: $DEST"
}

service_running() { launchctl print system/co.praxis.approval-service >/dev/null 2>&1; }
# stop the daemon and make sure it is stopped: data must never be changed under a running service
stop_service() {
  if service_running; then launchctl bootout system "$PLIST" 2>/dev/null || true; fi
  ! service_running || die "the service is still running after bootout; stop it yourself (launchctl bootout system \"$PLIST\") and run this again"
}

case "${1:-}" in
  health)
    OUT="$("$CODE/node/bin/node" "$CODE/praxis-approval-service.mjs" health --endpoint "$ENDPOINT")" || die "the service does not answer on $ENDPOINT"
    echo "$OUT"
    echo "$OUT" | grep -q '"mode": *"production"' || die "not in production mode"
    echo "$OUT" | tr -d '\n ' | grep -q '"isolation":{"verified":true' || die "isolation is not verified"
    echo "$OUT" | tr -d '\n ' | grep -q '"integrity":{"ok":true' || die "integrity problem reported"
    echo healthy ;;
  verify)
    F=0
    perm_expect "$BASE" root 755 || F=1
    perm_expect "$CODE" root 755 || F=1
    perm_expect "$CODE/node/bin/node" root 755 || F=1
    perm_expect "$CODE/ctl.sh" root 755 || F=1
    perm_expect "$CODE/MANIFEST.json" root 644 || F=1
    perm_expect "$CODE/praxis-approval-service.mjs" root 644 || F=1
    perm_expect "$BASE/config.json" root 644 || F=1
    perm_expect "$PLIST" root 644 || F=1
    perm_expect "$BACKUPS" root 700 || F=1
    perm_expect "$STATE" _praxisapproval 700 || F=1
    perm_expect "$SECRETS" _praxisapproval 700 || F=1
    perm_expect "$ANCHORS" _praxisapproval 700 || F=1
    perm_expect "$RUN" _praxisapproval 755 || F=1
    perm_expect "$LOGDIR" _praxisapproval 750 || F=1
    for sub in audit ledger trusted shared requests executions git-home; do [ ! -e "$STATE/$sub" ] || perm_expect "$STATE/$sub" _praxisapproval 700 || F=1; done
    [ ! -e "$STATE/trusted/private.pem" ] || perm_expect "$STATE/trusted/private.pem" _praxisapproval 600 || F=1
    [ ! -e "$STATE/audit/chain.jsonl" ] || perm_expect "$STATE/audit/chain.jsonl" _praxisapproval 600 || F=1
    [ ! -S "$ENDPOINT" ] || perm_expect "$ENDPOINT" _praxisapproval 666 || F=1
    psec_assert_tree "$CODE" && echo "PASS  the code tree has no links, no group/other-writable entry, no set-id bit, no write ACL"
    [ "$F" = 0 ] && echo "verified" || die "permissions are not as intended" ;;
  backup) backup "${2:-}" ;;
  rollback)
    need_root
    psec_assert_chain "$(dirname "$BASE")"; psec_assert_leaf "$BASE"
    # the newest backup that really holds code (a "-before-restore" folder or a damaged one is skipped)
    LAST=""
    for name in $(ls -1 "$BACKUPS" 2>/dev/null | sort -r); do
      case "$name" in *[!0-9]*|'') continue ;; esac
      [ -d "$BACKUPS/$name/code" ] && [ ! -L "$BACKUPS/$name" ] && [ ! -L "$BACKUPS/$name/code" ] || continue
      LAST="$name"; break
    done
    [ -n "$LAST" ] || die "no backup to roll back to"
    psec_assert_tree "$BACKUPS/$LAST/code"
    # prepare the old code next to the live one first: a failure here changes nothing
    rm -rf "$BASE/.code.new" "$BASE/.code.old"
    cp -R "$BACKUPS/$LAST/code" "$BASE/.code.new" || { rm -rf "$BASE/.code.new"; die "could not copy the backup's code; nothing was changed"; }
    chown -R root:wheel "$BASE/.code.new"; chmod -R go-w "$BASE/.code.new"
    psec_assert_tree "$BASE/.code.new"
    stop_service
    mv "$CODE" "$BASE/.code.old" && mv "$BASE/.code.new" "$CODE" || die "could not swap the code; the previous code is in $BASE/.code.old"
    rm -rf "$BASE/.code.old"
    psec_assert_tree "$CODE"
    launchctl bootstrap system "$PLIST"
    echo "rolled back the CODE to backup $LAST. State, ledger, audit and anchors were not touched, so approvals already used stay used." ;;
  restore-state)
    need_root
    psec_assert_chain "$(dirname "$BASE")"; psec_assert_leaf "$BASE"
    NAME="${2:-}"
    case "$NAME" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) : ;; *) die "'$NAME' is not a backup name (14 digits, as listed in $BACKUPS)" ;; esac
    DIR="$(backup_dir_of "$NAME")"
    [ -f "$DIR/state-and-config.tgz" ] && [ ! -L "$DIR/state-and-config.tgz" ] || die "that backup has no state archive"
    # An OLD state has an old ledger: restoring it would make approvals consumed since then usable again. So this is only for
    # recovery from lost or damaged state, only with the service stopped, and only when every approval that could still be valid
    # has expired: nothing in the CURRENT state may have changed within the last 25 hours (a plan lives minutes; 25 hours is a wide margin).
    ! service_running || die "stop the service first: launchctl bootout system $PLIST"
    NOW="$(date +%s)"
    NEWEST="$(find "$STATE" "$SECRETS" "$ANCHORS" -type f -exec stat -f %m {} + 2>/dev/null | sort -n | tail -n 1)"
    case "$NEWEST" in '') : ;; *[!0-9]*) die "cannot read the age of the current state; refusing" ;; *) [ $((NOW - NEWEST)) -ge 90000 ] || die "the current state changed less than 25 hours ago: approvals made since could still be valid, and restoring an older ledger would let them be used again. Use 'rollback' (code only) instead, or wait" ;; esac
    # the archive is root-only, but it is checked anyway: only the expected top-level names, plain files and directories only
    LIST="$(tar -tzf "$DIR/state-and-config.tgz")" || die "the backup archive cannot be read; nothing was changed"
    printf '%s\n' "$LIST" | grep -vE '^(state|secrets|anchors)(/|$)|^config\.json$' | grep -q . && die "the backup archive holds unexpected paths; nothing was changed"
    printf '%s\n' "$LIST" | grep -qE '(^|/)\.\.(/|$)|^/' && die "the backup archive holds unsafe paths; nothing was changed"
    tar -tvzf "$DIR/state-and-config.tgz" | cut -c1 | grep -qv '[-d]' && die "the backup archive holds links, devices or pipes; nothing was changed"
    umask 077
    SAFE="$BACKUPS/$(date +%Y%m%d%H%M%S)-before-restore"
    mkdir "$SAFE"
    ITEMS=""; for item in state config.json secrets anchors; do [ -e "$BASE/$item" ] && ITEMS="$ITEMS $item"; done
    # shellcheck disable=SC2086
    [ -z "$ITEMS" ] || tar -C "$BASE" -czf "$SAFE/state-and-config.tgz" $ITEMS || die "could not save the current state first; nothing was changed"
    # extract aside first: a failure here changes nothing
    TMP="$BASE/.restore.$$"; rm -rf "$TMP"; mkdir "$TMP"
    tar -C "$TMP" -xzf "$DIR/state-and-config.tgz" state secrets config.json 2>/dev/null || { rm -rf "$TMP"; die "could not unpack the backup; nothing was changed"; }
    # The anchors are NOT restored: they are the independent record. If they are newer than the restored state the service refuses to
    # start, which is the protection working. The owner resolves that deliberately (see INSTALL.md), never by this command.
    rm -rf "$STATE" "$SECRETS"
    for item in state secrets; do [ ! -e "$TMP/$item" ] || mv "$TMP/$item" "$BASE/$item"; done
    [ ! -e "$TMP/config.json" ] || { mv "$TMP/config.json" "$BASE/config.json"; chown root:wheel "$BASE/config.json"; chmod 0644 "$BASE/config.json"; }
    rm -rf "$TMP"
    chown -R "$ACCT:$ACCT" "$STATE" "$SECRETS" && chmod 0700 "$STATE" "$SECRETS" || die "could not give the restored state back to $ACCT; the previous state is in $SAFE"
    FAILED=0
    perm_expect "$STATE" "$ACCT" 700 || FAILED=1
    perm_expect "$SECRETS" "$ACCT" 700 || FAILED=1
    [ "$FAILED" = 0 ] || die "the restored state has wrong permissions (above); the previous state is in $SAFE"
    echo "state and secrets restored from $NAME (anchors left as they are); the previous state is saved in $SAFE. Start with: launchctl bootstrap system $PLIST ; then: ctl.sh verify ; ctl.sh health. If the service refuses to start because an anchor is newer than the restored state, that is the replay protection working." ;;
  uninstall)
    need_root
    MODE="${2:-}"
    case "$MODE" in
      ''|--remove-data) : ;;
      --delete-everything) [ "${3:-}" = "$DELETE_PHRASE" ] || die "--delete-everything deletes the backups too and cannot be undone: add the exact phrase '$DELETE_PHRASE' to confirm" ;;
      --purge) die "--purge no longer exists: use 'uninstall' (keeps data), '--remove-data' (removes live data after a recovery archive) or '--delete-everything $DELETE_PHRASE'" ;;
      *) die "unknown option $MODE" ;;
    esac
    stop_service            # first: the recovery archive must be a consistent snapshot, and nothing is changed under a running daemon
    backup
    ARCHIVE="$DEST/state-and-config.tgz"
    if [ "$MODE" = "--remove-data" ] || [ "$MODE" = "--delete-everything" ]; then
      [ -f "$ARCHIVE" ] || [ ! -e "$STATE" ] || die "no recovery archive was written; nothing was removed"
      [ ! -f "$ARCHIVE" ] || tar -tzf "$ARCHIVE" >/dev/null || die "the recovery archive cannot be read; nothing was removed"
    fi
    rm -f "$PLIST"
    rm -rf "$CODE"
    if [ "$MODE" = "--remove-data" ] || [ "$MODE" = "--delete-everything" ]; then
      rm -rf "$STATE" "$BASE/config.json" "$SECRETS" "$ANCHORS" "$RUN" "$LOGDIR"
      # only an account that is provably this installer's is deleted, and a failed deletion is reported
      if acct_user_exists || acct_group_exists; then
        acct_validate >/dev/null
        if acct_user_exists; then dscl . -delete "/Users/$ACCT" || die "could not delete the account $ACCT"; fi
        if acct_group_exists; then dscl . -delete "/Groups/$ACCT" || die "could not delete the group $ACCT"; fi
      fi
      echo "Removed the daemon, code, state, configuration, secrets, anchors and the service account. The recovery archive made just now ($ARCHIVE) and earlier backups remain in $BACKUPS (root only). The logs were removed and are not in the archive."
    else
      echo "Removed the daemon and the code. State, configuration, secrets, anchors, backups and the service account remain in $BASE."
    fi
    if [ "$MODE" = "--delete-everything" ]; then
      rm -rf "$BACKUPS"
      rmdir "$BASE" 2>/dev/null || true
      echo "Deleted the backups as well."
    fi ;;
  *) echo "usage: ctl.sh health|verify|backup|rollback|restore-state <backup>|uninstall [--remove-data | --delete-everything $DELETE_PHRASE]" >&2; exit 2 ;;
esac
