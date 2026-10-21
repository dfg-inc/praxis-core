#!/bin/sh
# Runs as root when the OWNER installs the .pkg. Praxis tooling never executes this.
# Compatibility checks, then a root-only backup of any existing installation (code, state, configuration) for rollback.
set -eu
PKG_ARCH="@ARCH@"
PKG_VERSION="@VERSION@"
BASE="/Library/Application Support/Praxis/ApprovalService"
CODE="$BASE/code"
BACKUPS="$BASE/backups"

[ "${3:-/}" = "/" ] || { echo "praxis-approval-service: install to the boot volume only" >&2; exit 1; }
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH:$PKG_ARCH" in
  arm64:arm64|x86_64:x64) : ;;
  *) echo "praxis-approval-service: this package is for $PKG_ARCH, this Mac is $HOST_ARCH" >&2; exit 1 ;;
esac
MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MAJOR" -ge 12 ] || { echo "praxis-approval-service: macOS 12 or newer is required" >&2; exit 1; }

# the base directory must not be a link and must be root-owned
if [ -e "$BASE" ]; then
  [ ! -L "$BASE" ] || { echo "praxis-approval-service: $BASE is a symbolic link; refusing" >&2; exit 1; }
  [ "$(stat -f %u "$BASE")" = 0 ] || { echo "praxis-approval-service: $BASE is not owned by root; refusing" >&2; exit 1; }
fi

if [ -f "$CODE/MANIFEST.json" ]; then
  PREV="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$CODE/MANIFEST.json" | head -n 1)"
  if [ -n "$PREV" ] && [ "$PREV" != "$PKG_VERSION" ] && [ "$(printf '%s\n%s\n' "$PKG_VERSION" "$PREV" | sort -V | tail -n 1)" = "$PREV" ] && [ ! -f "$BASE/allow-downgrade" ]; then
    echo "praxis-approval-service: installed $PREV is newer than $PKG_VERSION; create $BASE/allow-downgrade to proceed" >&2
    exit 1
  fi
  umask 077
  mkdir -p "$BACKUPS"
  chown root:wheel "$BACKUPS"; chmod 0700 "$BACKUPS"
  TS="$(date +%Y%m%d%H%M%S)"
  DEST="$BACKUPS/$TS"
  mkdir "$DEST"
  # a failed backup stops the installation: an upgrade must never destroy the only record of past approvals
  tar -C "$BASE" -czf "$DEST/state-and-config.tgz" state config.json 2>/dev/null || [ ! -d "$BASE/state" ]
  cp -R "$CODE" "$DEST/code"
  printf '%s\n' "$PREV" > "$DEST/version"
  # keep the five most recent backups
  ls -1 "$BACKUPS" | sort | head -n -5 2>/dev/null | while read -r old; do rm -rf "${BACKUPS:?}/$old"; done || true
fi
exit 0
