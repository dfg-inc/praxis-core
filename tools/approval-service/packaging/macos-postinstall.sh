#!/bin/sh
# Runs as root when the OWNER installs praxis-approval-service.pkg. Praxis tooling never executes this.
# Creates the dedicated role account, the protected directories, a default configuration (kept on upgrade) and starts
# the launchd daemon. It refuses to run against anything but the boot volume.
set -eu

[ "${3:-/}" = "/" ] || { echo "praxis-approval-service: install to the boot volume only" >&2; exit 1; }

PRINCIPAL="_praxisapproval"
BASE="/Library/Application Support/Praxis/ApprovalService"
CODE="$BASE/code"
LOGDIR="/var/log/praxis-approval"
PLIST="/Library/LaunchDaemons/co.praxis.approval-service.plist"

# Every ancestor of the code directory must be root-owned and not writable by group or others, or whoever can write there
# can replace what runs as the service account.
dir="$CODE"
while [ "$dir" != "/" ]; do
  [ ! -L "$dir" ] || { echo "praxis-approval-service: $dir is a symbolic link" >&2; exit 1; }
  [ "$(stat -f %u "$dir")" = 0 ] || { echo "praxis-approval-service: $dir is not owned by root" >&2; exit 1; }
  perm="$(stat -f %Lp "$dir")"
  case "$perm" in ?[2367]?|??[2367]) echo "praxis-approval-service: $dir is writable by group or others ($perm)" >&2; exit 1 ;; esac
  dir="$(dirname "$dir")"
done

free_id() {
  i=200
  while [ "$i" -lt 400 ]; do
    if ! dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$i" && ! dscl . -list /Groups PrimaryGroupID | awk '{print $2}' | grep -qx "$i"; then
      echo "$i"; return 0
    fi
    i=$((i + 1))
  done
  return 1
}

if ! dscl . -read "/Users/$PRINCIPAL" >/dev/null 2>&1 && ! dscl . -read "/Groups/$PRINCIPAL" >/dev/null 2>&1; then
  ID="$(free_id)"
  dseditgroup -o create -r "Praxis Approval Service" -i "$ID" "$PRINCIPAL"
  dscl . -create "/Users/$PRINCIPAL"
  dscl . -create "/Users/$PRINCIPAL" UserShell /usr/bin/false
  dscl . -create "/Users/$PRINCIPAL" RealName "Praxis Approval Service"
  dscl . -create "/Users/$PRINCIPAL" UniqueID "$ID"
  dscl . -create "/Users/$PRINCIPAL" PrimaryGroupID "$ID"
  dscl . -create "/Users/$PRINCIPAL" NFSHomeDirectory /var/empty
  dscl . -create "/Users/$PRINCIPAL" Password '*'
  dscl . -create "/Users/$PRINCIPAL" IsHidden 1
else
  dscl . -read "/Users/$PRINCIPAL" UniqueID >/dev/null 2>&1 || { echo "praxis-approval-service: a group named $PRINCIPAL exists without the matching account; resolve this first" >&2; exit 1; }
fi

install -d -o "$PRINCIPAL" -g "$PRINCIPAL" -m 0700 "$BASE/state"
install -d -o "$PRINCIPAL" -g "$PRINCIPAL" -m 0755 "$BASE/run"
install -d -o "$PRINCIPAL" -g "$PRINCIPAL" -m 0750 "$LOGDIR"

if [ ! -f "$BASE/config.json" ]; then
  umask 022
  cat > "$BASE/config.json" <<JSON
{
  "mode": "production",
  "principal": "$PRINCIPAL",
  "repositories": [],
  "operator": { "port": 8780, "origin": "http://localhost:8780" }
}
JSON
  chown root:wheel "$BASE/config.json"
  chmod 0644 "$BASE/config.json"
fi

chown -R root:wheel "$CODE"
chmod -R go-w "$CODE"
chown root:wheel "$PLIST"
chmod 0644 "$PLIST"

launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap system "$PLIST"
echo "Praxis Approval Service installed. Check: \"$CODE/ctl.sh\" health. Then enroll an authenticator (docs/approval-service/INSTALL.md)."
exit 0
