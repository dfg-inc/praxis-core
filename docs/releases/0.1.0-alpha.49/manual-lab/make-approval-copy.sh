#!/usr/bin/env bash
# Makes an isolated COPY of the orders-app project (with its Work Item) for the human-approval check (scenario H).
# The lab project and its Work Item are only read, never written. Safe to re-run: the copy is rebuilt from scratch.
set -euo pipefail
LAB="${PRAXIS_LAB:-$HOME/praxis-alpha49-lab}"
SRC="$LAB/projects/orders-app"
DST="${PRAXIS_APPROVAL_COPY:-$HOME/praxis-alpha49-approval-copy}"
[ -d "$SRC/.praxis" ] || { echo "no Work Item in $SRC"; exit 1; }
case "$DST" in "$LAB"/*|"$SRC"*) echo "refusing: the copy must live outside the lab"; exit 2;; esac
rm -rf "$DST"; mkdir -p "$DST"
rsync -a --exclude node_modules "$SRC/" "$DST/"
( cd "$SRC/.praxis/workflow/items" && shasum -a 256 *.json ) > "$DST/.source-sha256"
echo "copy: $DST"
echo "source Work Item fingerprint saved to $DST/.source-sha256"
echo "next:  ./start-alpha49.sh approval"
