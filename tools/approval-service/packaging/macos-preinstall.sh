#!/bin/sh
# Runs as root when the OWNER installs the .pkg, BEFORE the installer lays down any file. Praxis tooling never executes this.
# Order: compatibility, then EVERY safety check on the locations that will be used (and the account), then a root-only backup of
# any existing installation. Anything unsafe stops the installation here, before a single file has been written.
set -eu
PKG_ARCH="@ARCH@"
PKG_VERSION="@VERSION@"
BASE="/Library/Application Support/Praxis/ApprovalService"
CODE="$BASE/code"
BACKUPS="$BASE/backups"
STATE="$BASE/state"
RUN="$BASE/run"
SECRETS="$BASE/secrets"
ANCHORS="$BASE/anchors"
LOGDIR="/private/var/log/praxis-approval"
PLIST="/Library/LaunchDaemons/co.praxis.approval-service.plist"

# @@LIB@@

[ "${3:-/}" = "/" ] || psec_fail "install to the boot volume only"
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH:$PKG_ARCH" in
  arm64:arm64|x86_64:x64) : ;;
  *) psec_fail "this package is for $PKG_ARCH, this Mac is $HOST_ARCH" ;;
esac
MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MAJOR" -ge 12 ] || psec_fail "macOS 12 or newer is required"

# the service runs Git as its own account through /usr/bin/git, which needs the Xcode Command Line Tools (or Xcode) to be installed system-wide
/usr/bin/git --version >/dev/null 2>&1 || psec_fail "/usr/bin/git does not run; install the Xcode Command Line Tools (xcode-select --install) first"

# --- every location, before anything is extracted ------------------------------------------------------------------------------
# Ancestors must be root-controlled: not links (dangling ones included), owned by root, not writable by group or others, no
# write-granting ACL entry. The installation's own directories are checked as chains up to their parent and as leaves.
for dir in "$BASE" "$CODE" "$BACKUPS" "$STATE" "$RUN" "$SECRETS" "$ANCHORS" "$LOGDIR" "$PLIST"; do
  parent="$(dirname "$dir")"
  psec_assert_chain "$parent"
done
SVC_UID=""
if acct_user_exists; then SVC_UID="$(dget "/Users/$ACCT" UniqueID)"; fi
psec_assert_leaf "$BASE"
psec_assert_leaf "$CODE"
psec_assert_leaf "$BACKUPS"
psec_assert_leaf "$STATE" "$SVC_UID"
psec_assert_leaf "$RUN" "$SVC_UID"
psec_assert_leaf "$SECRETS" "$SVC_UID"
psec_assert_leaf "$ANCHORS" "$SVC_UID"
psec_assert_leaf "$LOGDIR" "$SVC_UID"
psec_check_component "$PLIST"
# an installation that is already there: its code must be clean too (nothing planted next to it)
[ ! -d "$CODE" ] || psec_assert_tree "$CODE"
if [ -d "$BACKUPS" ]; then
  for b in "$BACKUPS"/* "$BACKUPS"/.[!.]* "$BACKUPS"/..?*; do
    { [ -e "$b" ] || [ -L "$b" ]; } || continue   # an unmatched glob stays literal
    [ ! -L "$b" ] || psec_fail "$b is a symbolic link (or a dangling one) inside the backups; refusing"
  done
fi
[ ! -e "$BASE/allow-downgrade" ] || [ -f "$BASE/allow-downgrade" ] && [ ! -L "$BASE/allow-downgrade" ] || psec_fail "$BASE/allow-downgrade must be a plain file; refusing"

# the service account, if there is one, must be provably ours and in a state we can complete
acct_validate >/dev/null

if [ -f "$CODE/MANIFEST.json" ]; then
  PREV="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$CODE/MANIFEST.json" | head -n 1)"
  if [ -n "$PREV" ] && [ "$PREV" != "$PKG_VERSION" ] && version_gt "$PREV" "$PKG_VERSION" && [ ! -f "$BASE/allow-downgrade" ]; then
    psec_fail "installed $PREV is newer than $PKG_VERSION; create $BASE/allow-downgrade to proceed"
  fi
  # a snapshot of a service that is writing could be torn: stop it first (it is started again by postinstall, or here if the backup fails)
  SERVICE_WAS_UP=0
  if launchctl print system/co.praxis.approval-service >/dev/null 2>&1; then SERVICE_WAS_UP=1; launchctl bootout system "$PLIST" >/dev/null 2>&1 || true; fi
  backup_fail() { [ "$SERVICE_WAS_UP" = 0 ] || launchctl bootstrap system "$PLIST" >/dev/null 2>&1 || true; psec_fail "$1"; }
  umask 077
  mkdir -p "$BACKUPS"
  chown root:wheel "$BACKUPS"; chmod 0700 "$BACKUPS"
  TS="$(date +%Y%m%d%H%M%S)"
  DEST="$BACKUPS/$TS"
  mkdir "$DEST"
  # a failed backup stops the installation: an upgrade must never destroy the only record of past approvals
  ITEMS=""
  for item in state config.json secrets anchors; do [ -e "$BASE/$item" ] && ITEMS="$ITEMS $item"; done
  if [ -n "$ITEMS" ]; then
    # shellcheck disable=SC2086
    tar -C "$BASE" -czf "$DEST/state-and-config.tgz" $ITEMS || backup_fail "backup failed; nothing was changed"
  fi
  cp -R "$CODE" "$DEST/code" || backup_fail "backup of the code failed; nothing was changed"
  printf '%s\n' "$PREV" > "$DEST/version"
  # Backups are never deleted automatically: they are the only record of past approvals. Say so when there are many.
  [ "$(ls -1 "$BACKUPS" | wc -l | tr -d ' ')" -le 5 ] || echo "praxis-approval-service: note: $(ls -1 "$BACKUPS" | wc -l | tr -d ' ') backups are kept in $BACKUPS; remove old ones yourself when you no longer need them" >&2
fi
exit 0
