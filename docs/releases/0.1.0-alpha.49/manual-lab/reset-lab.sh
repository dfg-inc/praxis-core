#!/usr/bin/env bash
# Throws away the lab's projects (and their Praxis state) so a scenario can be repeated from the start. Keeps the profile and the marketplace.
set -euo pipefail
LAB="${PRAXIS_LAB:-$HOME/praxis-alpha49-lab}"
[ -d "$LAB/projects" ] || { echo "nothing to reset"; exit 0; }
echo "This deletes $LAB/projects (only the lab; nothing else). Press Enter to continue, Ctrl-C to cancel."; read -r _
rm -rf "$LAB/projects"
"$(dirname "$0")/setup-lab.sh"
