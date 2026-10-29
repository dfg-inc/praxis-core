#!/usr/bin/env bash
# Starts Claude Code in the lab with the LOCAL alpha.49 build, in a separate profile.
#   ./start-alpha49.sh orders-app        single-repository project
#   ./start-alpha49.sh multi             the folder that holds the three repositories
#   ./start-alpha49.sh legacy            the copy used for the alpha.48 upgrade check
#   ./start-alpha49.sh new               an empty project (BA canon initialisation)
#   ./start-alpha49.sh approval          the isolated copy made by make-approval-copy.sh (human-approval check)
# Your normal Claude (and the published alpha.48 in it) is not used and not changed.
# First start only: type /login inside this Claude session once (the lab profile is separate and starts logged out).
set -euo pipefail
LAB="${PRAXIS_LAB:-$HOME/praxis-alpha49-lab}"
case "${1:-orders-app}" in
  orders-app) DIR="$LAB/projects/orders-app" ;;
  multi)      DIR="$LAB/projects/multi" ;;
  legacy)     DIR="$LAB/projects/orders-legacy" ;;
  approval)   DIR="${PRAXIS_APPROVAL_COPY:-$HOME/praxis-alpha49-approval-copy}" ;;
  new)        DIR="$LAB/projects/new-project"; mkdir -p "$DIR"; [ -d "$DIR/.git" ] || git init -q "$DIR" ;;
  *) echo "usage: $0 orders-app|multi|legacy|new|approval"; exit 2 ;;
esac
[ -d "$DIR" ] || { echo "run setup-lab.sh first"; exit 1; }
export CLAUDE_CONFIG_DIR="$LAB/claude-config"
cd "$DIR"
echo "lab profile: $CLAUDE_CONFIG_DIR"; echo "project: $PWD"
claude mcp list 2>/dev/null | grep -i praxis || echo "(the Praxis Runtime shows up as Connected once the session starts)"
exec claude
