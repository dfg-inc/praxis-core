#!/bin/sh
# Runs as root when the OWNER installs praxis-approval-service.pkg, after the payload is in place. Praxis tooling never executes this.
# Re-checks the locations (the payload has now been written), validates or completes the service account, creates the protected
# directories, writes the default configuration only when there is none, verifies every permission it created, and starts the daemon.
set -eu

BASE="/Library/Application Support/Praxis/ApprovalService"
CODE="$BASE/code"
STATE="$BASE/state"
RUN="$BASE/run"
SECRETS="$BASE/secrets"
ANCHORS="$BASE/anchors"
BACKUPS="$BASE/backups"
LOGDIR="/private/var/log/praxis-approval"
PLIST="/Library/LaunchDaemons/co.praxis.approval-service.plist"

# @@LIB@@

[ "${3:-/}" = "/" ] || psec_fail "install to the boot volume only"

# --- the code and the plist, as extracted -------------------------------------------------------------------------------------------
for dir in "$CODE" "$PLIST"; do psec_assert_chain "$(dirname "$dir")"; done
psec_assert_leaf "$BASE"
psec_assert_leaf "$CODE"
psec_assert_tree "$CODE"
psec_check_component "$PLIST"
# exactly the payload, nothing more: a file somebody planted next to it is not accepted
EXPECTED="MANIFEST.json ctl.sh node/bin/node praxis-approval-service.mjs"
for f in $EXPECTED; do [ -f "$CODE/$f" ] || psec_fail "$CODE/$f is missing from the payload; refusing"; done
EXTRA="$(cd "$CODE" && find . -mindepth 1 | sed 's|^\./||' | sort | grep -vxF -e MANIFEST.json -e ctl.sh -e node -e node/bin -e node/bin/node -e praxis-approval-service.mjs || true)"
[ -z "$EXTRA" ] || psec_fail "unexpected entry(ies) in the code directory: $(echo "$EXTRA" | tr '\n' ' '); refusing"
[ -x "$CODE/node/bin/node" ] || psec_fail "the bundled Node is not executable"

# --- the service account: validate what exists, complete what an interrupted installation left, create what is missing -------------
free_id() {
  i=200
  while [ "$i" -lt 400 ]; do
    if [ "$(acct_count_uid "$i")" = 0 ] && [ "$(acct_count_gid "$i")" = 0 ]; then echo "$i"; return 0; fi
    i=$((i + 1))
  done
  return 1
}
STATE_OF_ACCOUNT="$(acct_validate)"
case "$STATE_OF_ACCOUNT" in
  absent)
    ID="$(free_id)" || psec_fail "no free UID/GID in 200-399"
    dseditgroup -o create -r "$ACCT_REALNAME" -i "$ID" "$ACCT"
    ;;
  group-only) ID="$(dget "/Groups/$ACCT" PrimaryGroupID)"; [ "$(acct_count_uid "$ID")" = 0 ] || psec_fail "UID $ID is taken; refusing to complete the account" ;;
  user-only)
    ID="$(dget "/Users/$ACCT" UniqueID)"
    [ "$(acct_count_gid "$ID")" = 0 ] || psec_fail "GID $ID is taken; refusing to complete the account"
    dseditgroup -o create -r "$ACCT_REALNAME" -i "$ID" "$ACCT"
    ;;
  complete) ID="$(dget "/Users/$ACCT" UniqueID)" ;;
esac
# set only what is absent; acct_validate has already refused anything present and wrong
setattr() { [ -n "$(dget "/Users/$ACCT" "$1")" ] || dscl . -create "/Users/$ACCT" "$1" "$2"; }
acct_user_exists || dscl . -create "/Users/$ACCT"
setattr RealName "$ACCT_REALNAME"
setattr UserShell /usr/bin/false
setattr UniqueID "$ID"
setattr PrimaryGroupID "$ID"
setattr NFSHomeDirectory /var/empty
setattr Password '*'
setattr IsHidden 1
acct_validate >/dev/null || psec_fail "the service account is not in the expected state after setup"
SVC_UID="$ID"

# --- directories ---------------------------------------------------------------------------------------------------------------------
mk() { # mk <path> <owner> <group> <mode>
  install -d -o "$2" -g "$3" -m "$4" "$1"
  chown "$2:$3" "$1"; chmod "$4" "$1"
}
# a directory that already exists must be ours (or root's) before it is touched: never take over somebody else's
for d in "$STATE" "$RUN" "$SECRETS" "$ANCHORS" "$LOGDIR"; do psec_assert_leaf "$d" "$SVC_UID"; done
psec_assert_leaf "$BACKUPS"
mk "$STATE" "$ACCT" "$ACCT" 0700
mk "$RUN" "$ACCT" "$ACCT" 0755
mk "$SECRETS" "$ACCT" "$ACCT" 0700
mk "$ANCHORS" "$ACCT" "$ACCT" 0700
mk "$LOGDIR" "$ACCT" "$ACCT" 0750
mk "$BACKUPS" root wheel 0700
psec_assert_leaf "$STATE" "$SVC_UID"; psec_assert_leaf "$RUN" "$SVC_UID"; psec_assert_leaf "$SECRETS" "$SVC_UID"; psec_assert_leaf "$ANCHORS" "$SVC_UID"; psec_assert_leaf "$LOGDIR" "$SVC_UID"

# --- configuration: PUBLIC settings only (root-owned, readable); credentials live in $SECRETS and are only named here ---------------------
if [ ! -f "$BASE/config.json" ]; then
  umask 022
  cat > "$BASE/config.json" <<JSON
{
  "mode": "production",
  "principal": "$ACCT",
  "repositories": [],
  "operator": { "port": 8780, "origin": "http://localhost:8780" },
  "auditAnchorDirs": ["$ANCHORS"]
}
JSON
fi
chown root:wheel "$BASE/config.json"
chmod 0644 "$BASE/config.json"

chown -R root:wheel "$CODE"
chmod -R go-w "$CODE"
chmod 0644 "$CODE/MANIFEST.json" "$CODE/praxis-approval-service.mjs"
chmod 0755 "$CODE/ctl.sh" "$CODE/node/bin/node"
chown root:wheel "$PLIST"
chmod 0644 "$PLIST"

# --- verify what was created --------------------------------------------------------------------------------------------------------
FAILED=0
perm_expect "$BASE" root 755 || FAILED=1
perm_expect "$CODE" root 755 || FAILED=1
perm_expect "$STATE" "$ACCT" 700 || FAILED=1
perm_expect "$RUN" "$ACCT" 755 || FAILED=1
perm_expect "$SECRETS" "$ACCT" 700 || FAILED=1
perm_expect "$ANCHORS" "$ACCT" 700 || FAILED=1
perm_expect "$LOGDIR" "$ACCT" 750 || FAILED=1
perm_expect "$BACKUPS" root 700 || FAILED=1
perm_expect "$BASE/config.json" root 644 || FAILED=1
perm_expect "$PLIST" root 644 || FAILED=1
[ "$FAILED" = 0 ] || psec_fail "a permission is not as intended (see above); the daemon was NOT started"

rm -f "$BASE/allow-downgrade"   # a one-time permission
launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap system "$PLIST"
echo "Praxis Approval Service installed. Check: \"$CODE/ctl.sh\" health and \"$CODE/ctl.sh\" verify. Then enroll an authenticator (docs/approval-service/INSTALL.md)."
exit 0
