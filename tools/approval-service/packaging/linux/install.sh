#!/bin/sh
# Praxis Approval Service — Linux installer, run by the OWNER as root. Praxis tooling never runs it.
#
#   install.sh check                  compatibility checks only; changes nothing
#   install.sh install [--dry-run]    install (or upgrade, when a previous version exists)
#   install.sh upgrade [--dry-run] [--allow-downgrade]
#   install.sh backup                 tar the state and configuration to /var/backups/praxis-approval
#   install.sh rollback [--restore-state <backup.tgz>]   switch back to the previous version
#   install.sh health                 ask the running service for its health (exit 0 only if production + isolated)
#   install.sh uninstall [--purge]    remove code and unit; keep state unless --purge (a backup is taken first)
#
# Environment: PRAXIS_NO_SYSTEMD=1 skips systemctl (containers, tests).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PRINCIPAL="praxis-approval"
OPT="/opt/praxis-approval-service"
ETC="/etc/praxis-approval"
STATE="/var/lib/praxis-approval"
RUN="/run/praxis-approval"
LOGDIR="/var/log/praxis-approval"
BACKUPS="/var/backups/praxis-approval"
UNIT="/etc/systemd/system/praxis-approval.service"
ENDPOINT="$RUN/service.sock"
DRY=0
ALLOW_DOWNGRADE=0
ACTION="${1:-}"
[ $# -gt 0 ] && shift || true
RESTORE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --allow-downgrade) ALLOW_DOWNGRADE=1 ;;
    --purge) PURGE=1 ;;
    --restore-state) shift; RESTORE="${1:-}" ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
PURGE="${PURGE:-0}"

say() { printf '%s\n' "$*"; }
die() { printf 'praxis-approval-service: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then say "DRY-RUN: $*"; else "$@"; fi; }

manifest_get() { # manifest_get <key>  — reads a top-level string/number from MANIFEST.json (no jq dependency)
  sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}.*/\1/p" "$HERE/MANIFEST.json" | head -n 1
}
VERSION="$(manifest_get version)"
PROTOCOL="$(manifest_get protocol)"
ARCH_WANT="$(manifest_get linuxArch)"

host_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo "$(uname -m)" ;;
  esac
}

version_gt() { # version_gt a b : is a newer than b (numeric dotted prefix, then plain string)
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
}

check() {
  [ "$(id -u)" = 0 ] || die "must run as root (the owner's administrator step)"
  [ -n "$VERSION" ] || die "MANIFEST.json is missing or unreadable"
  [ "$(uname -s)" = Linux ] || die "this package is for Linux"
  [ "$(host_arch)" = "$ARCH_WANT" ] || die "this package is built for $ARCH_WANT, this machine is $(host_arch)"
  ( cd "$HERE" && sha256sum -c SHA256SUMS >/dev/null ) || die "package files do not match SHA256SUMS; refusing"
  NODE_V="$("$HERE/payload/node/bin/node" --version 2>/dev/null)" || die "the bundled Node does not run on this machine (wrong libc or architecture?)"
  case "$NODE_V" in v2[0-9].*|v[3-9][0-9].*) : ;; *) die "bundled Node $NODE_V is older than the supported v20" ;; esac
  for tool in useradd install tar sha256sum sort; do command -v "$tool" >/dev/null 2>&1 || die "required tool missing: $tool"; done
  if [ -L "$OPT" ] || [ -L "$ETC" ] || [ -L "$STATE" ]; then die "$OPT, $ETC or $STATE is a symbolic link; refusing"; fi
  if [ -d "$OPT/current" ] || [ -L "$OPT/current" ]; then
    PREV="$(basename "$(readlink -f "$OPT/current")")"
    if [ "$PREV" != "$VERSION" ] && ! version_gt "$VERSION" "$PREV" && [ "$ALLOW_DOWNGRADE" != 1 ]; then
      die "installed version $PREV is newer than $VERSION; use --allow-downgrade to proceed"
    fi
    if [ -x "$OPT/current/node/bin/node" ] && [ -S "$ENDPOINT" ]; then
      RUNNING="$("$OPT/current/node/bin/node" "$OPT/current/praxis-approval-service.mjs" health --endpoint "$ENDPOINT" 2>/dev/null | sed -n 's/.*"protocol": *"\([^"]*\)".*/\1/p' | head -n 1)" || true
      if [ -n "$RUNNING" ] && [ "$RUNNING" != "$PROTOCOL" ]; then
        say "note: the running service speaks $RUNNING and this package $PROTOCOL; Runtime clients must be upgraded together"
      fi
    fi
  fi
  say "ok: Linux $(host_arch), Node $NODE_V, package $VERSION ($PROTOCOL)"
  if [ -d /run/systemd/system ] && [ "${PRAXIS_NO_SYSTEMD:-0}" != 1 ]; then say "ok: systemd present"; else say "note: systemd not available or disabled; the unit will be installed but not started"; fi
}

backup() {
  [ "$(id -u)" = 0 ] || die "must run as root"
  TS="$(date +%Y%m%d%H%M%S)"
  install -d -o root -g root -m 0700 "$BACKUPS"
  OUT="$BACKUPS/praxis-approval-$TS.tgz"
  if [ -d "$STATE" ] || [ -d "$ETC" ]; then
    run tar -C / -czf "$OUT" "${STATE#/}" "${ETC#/}" 2>/dev/null || true
    [ "$DRY" = 1 ] || chmod 0600 "$OUT"
    say "backup: $OUT"
  else
    say "nothing to back up"
  fi
}

ensure_user() {
  if ! id -u "$PRINCIPAL" >/dev/null 2>&1; then
    run useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$PRINCIPAL"
  fi
  # the service account must not be able to log in or hold other group memberships that widen its reach
  if [ "$DRY" != 1 ] && [ "$(id -nG "$PRINCIPAL" | wc -w)" -gt 1 ]; then die "$PRINCIPAL belongs to more than one group: $(id -nG "$PRINCIPAL")"; fi
}

install_files() {
  NEW="$OPT/$VERSION"
  run install -d -o root -g root -m 0755 "$OPT"
  if [ -e "$NEW" ] && [ "$DRY" != 1 ]; then rm -rf "$NEW.tmp"; fi
  run install -d -o root -g root -m 0755 "$NEW.tmp" "$NEW.tmp/node" "$NEW.tmp/node/bin"
  run install -o root -g root -m 0755 "$HERE/payload/node/bin/node" "$NEW.tmp/node/bin/node"
  run install -o root -g root -m 0644 "$HERE/payload/praxis-approval-service.mjs" "$NEW.tmp/praxis-approval-service.mjs"
  run install -o root -g root -m 0644 "$HERE/MANIFEST.json" "$NEW.tmp/MANIFEST.json"
  run install -o root -g root -m 0755 "$HERE/install.sh" "$NEW.tmp/ctl.sh"
  run install -o root -g root -m 0644 "$HERE/SHA256SUMS" "$NEW.tmp/SHA256SUMS"
  if [ "$DRY" != 1 ]; then
    rm -rf "$NEW"
    mv "$NEW.tmp" "$NEW"
    # switch the "current" link atomically; keep the previous version directory for rollback
    PREV_TARGET="$(readlink "$OPT/current" 2>/dev/null || true)"
    [ -n "$PREV_TARGET" ] && printf '%s\n' "$PREV_TARGET" > "$OPT/.previous" && chmod 0644 "$OPT/.previous"
    ln -sfn "$NEW" "$OPT/current.new"
    mv -T "$OPT/current.new" "$OPT/current"
  else
    say "DRY-RUN: switch $OPT/current -> $NEW"
  fi
}

install_config() {
  run install -d -o root -g root -m 0755 "$ETC"
  if [ ! -f "$ETC/config.json" ]; then
    if [ "$DRY" = 1 ]; then say "DRY-RUN: write $ETC/config.json"; else
      cat > "$ETC/config.json" <<JSON
{
  "mode": "production",
  "principal": "$PRINCIPAL",
  "repositories": [],
  "operator": { "port": 8780, "origin": "http://localhost:8780" }
}
JSON
      chown root:root "$ETC/config.json"; chmod 0644 "$ETC/config.json"
    fi
  else
    say "kept existing $ETC/config.json"
  fi
  run install -d -o "$PRINCIPAL" -g "$PRINCIPAL" -m 0700 "$STATE"
  run install -d -o "$PRINCIPAL" -g "$PRINCIPAL" -m 0750 "$LOGDIR"
}

install_unit() {
  if [ "$DRY" = 1 ]; then say "DRY-RUN: install $UNIT"; return; fi
  install -o root -g root -m 0644 "$HERE/praxis-approval.service" "$UNIT"
  if [ -d /run/systemd/system ] && [ "${PRAXIS_NO_SYSTEMD:-0}" != 1 ]; then
    systemctl daemon-reload
    systemctl enable praxis-approval.service >/dev/null
    systemctl restart praxis-approval.service
  else
    install -d -o "$PRINCIPAL" -g "$PRINCIPAL" -m 0755 "$RUN"
    say "systemd not used: start the service with: runuser -u $PRINCIPAL -- env -i PATH=/usr/bin:/bin $OPT/current/node/bin/node $OPT/current/praxis-approval-service.mjs run --config $ETC/config.json"
  fi
}

do_install() {
  check
  if [ -d "$STATE" ] || [ -L "$OPT/current" ]; then DRY_SAVE=$DRY; backup; DRY=$DRY_SAVE; fi
  ensure_user
  install_files
  install_config
  install_unit
  say "installed $VERSION. Next: enroll an authenticator (docs/approval-service/INSTALL.md), then: $OPT/current/ctl.sh health"
}

health() {
  [ -x "$OPT/current/node/bin/node" ] || die "not installed"
  OUT="$("$OPT/current/node/bin/node" "$OPT/current/praxis-approval-service.mjs" health --endpoint "$ENDPOINT")" || die "the service does not answer on $ENDPOINT"
  printf '%s\n' "$OUT"
  printf '%s' "$OUT" | grep -q '"mode": *"production"' || die "service is not in production mode"
  printf '%s' "$OUT" | tr -d '\n ' | grep -q '"isolation":{"verified":true' || die "service does not report verified isolation"
  printf '%s' "$OUT" | tr -d '\n ' | grep -q '"integrity":{"ok":true' || die "service reports an integrity problem"
  say "healthy"
}

rollback() {
  [ "$(id -u)" = 0 ] || die "must run as root"
  [ -f "$OPT/.previous" ] || die "no previous version recorded"
  PREV="$(cat "$OPT/.previous")"
  [ -d "$PREV" ] || die "previous version directory $PREV is gone"
  case "$PREV" in "$OPT"/*) : ;; *) die "recorded previous version is outside $OPT" ;; esac
  CUR="$(readlink "$OPT/current")"
  if [ "$DRY" != 1 ]; then
    ln -sfn "$PREV" "$OPT/current.new"
    mv -T "$OPT/current.new" "$OPT/current"
    printf '%s\n' "$CUR" > "$OPT/.previous"
    if [ -n "$RESTORE" ]; then
      case "$RESTORE" in "$BACKUPS"/*) : ;; *) die "--restore-state must name a file inside $BACKUPS" ;; esac
      [ -f "$RESTORE" ] || die "no such backup"
      say "restoring state from $RESTORE. Warning: restoring an older ledger makes consumed approvals usable again; the service's integrity anchors will refuse to start on an older state unless you also restore the anchors from the same backup."
      tar -C / -xzf "$RESTORE"
    fi
    if [ -d /run/systemd/system ] && [ "${PRAXIS_NO_SYSTEMD:-0}" != 1 ]; then systemctl restart praxis-approval.service; fi
  fi
  say "rolled back to $PREV"
}

uninstall() {
  [ "$(id -u)" = 0 ] || die "must run as root"
  backup
  if [ -d /run/systemd/system ] && [ "${PRAXIS_NO_SYSTEMD:-0}" != 1 ]; then
    systemctl disable --now praxis-approval.service 2>/dev/null || true
  fi
  run rm -f "$UNIT"
  [ -d /run/systemd/system ] && [ "${PRAXIS_NO_SYSTEMD:-0}" != 1 ] && systemctl daemon-reload || true
  run rm -rf "$OPT"
  if [ "$PURGE" = 1 ]; then
    run rm -rf "$STATE" "$ETC" "$LOGDIR" "$RUN"
    id -u "$PRINCIPAL" >/dev/null 2>&1 && run userdel "$PRINCIPAL" || true
    say "purged state, configuration and the service account (backup kept in $BACKUPS)"
  else
    say "removed code and unit; kept $STATE, $ETC and the service account (use --purge to remove them)"
  fi
}

case "$ACTION" in
  check) check ;;
  install|upgrade) do_install ;;
  backup) backup ;;
  rollback) rollback ;;
  health) health ;;
  uninstall) uninstall ;;
  *) echo "usage: install.sh check|install|upgrade|backup|rollback|health|uninstall [--dry-run] [--purge] [--allow-downgrade] [--restore-state FILE]" >&2; exit 2 ;;
esac
