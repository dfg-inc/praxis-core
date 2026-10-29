#!/usr/bin/env bash
# Creates the manual test lab OUTSIDE your normal Claude setup:
#   ~/praxis-alpha49-lab/            everything lives here; delete the folder to remove it
#     claude-config/                 a SEPARATE Claude Code profile (CLAUDE_CONFIG_DIR) - your normal ~/.claude and the published alpha.48 are not touched
#     marketplace/                   a git clone of the local alpha.49 marketplace branch (read from your working copy, nothing is pushed)
#     projects/orders-app/           one small project for the single-repository checks (git repository, a real frontend with styles)
#     projects/orders-legacy/        a copy of orders-app for the alpha.48 -> alpha.49 upgrade check
#     projects/multi/{orders-backend,orders-web,orders-mobile}/   three independent git repositories for the multi-repository check
# Safe to run again: it never deletes anything; use ./reset-lab.sh to start over.
set -euo pipefail
LAB="${PRAXIS_LAB:-$HOME/praxis-alpha49-lab}"
SRC="${PRAXIS_MARKETPLACE_SRC:-<praxis-split>/praxis-marketplace}"
BRANCH="${PRAXIS_MARKETPLACE_BRANCH:-feature/ux-overhaul}"
mkdir -p "$LAB/claude-config" "$LAB/projects"

# 1. the local marketplace (a clone of the branch; refreshed on every run)
if [ -d "$LAB/marketplace/.git" ]; then
  git -C "$LAB/marketplace" fetch -q "$SRC" "$BRANCH"
  git -C "$LAB/marketplace" reset -q --hard FETCH_HEAD
else
  git clone -q --branch "$BRANCH" "$SRC" "$LAB/marketplace"
fi
echo "marketplace: $(git -C "$LAB/marketplace" log --oneline -1)"

# 2. install into the SEPARATE profile only
export CLAUDE_CONFIG_DIR="$LAB/claude-config"
if ! claude plugin marketplace list 2>/dev/null | grep -q praxis; then
  claude plugin marketplace add "$LAB/marketplace"
else
  claude plugin marketplace update praxis >/dev/null 2>&1 || true
fi
# The plugin versions in the manifests did not change between builds, so `plugin update` would keep the old copy in the lab's cache.
# Reinstall inside the lab profile (only the plugin files; the login, your projects and their Praxis state are not touched).
for p in praxis praxis-runtime praxis-ba praxis-architect praxis-developer praxis-quality; do claude plugin uninstall "$p@praxis" >/dev/null 2>&1 || true; done
claude plugin install praxis@praxis >/dev/null 2>&1 || { echo "install failed in the lab profile"; exit 1; }
echo "installed in the lab profile:"; claude plugin list 2>/dev/null | grep -E "praxis" || true

# 3. the small single-repository project (a real frontend with its own styles)
P="$LAB/projects/orders-app"
if [ ! -d "$P/.git" ]; then
  mkdir -p "$P/src/pages" "$P/src/components" "$P/src/styles"
  cat > "$P/package.json" <<'JSON'
{ "name": "orders-app", "private": true, "type": "module", "dependencies": { "react": "18.2.0" } }
JSON
  cat > "$P/src/styles/theme.css" <<'CSS'
:root {
  --color-primary: #0b6bcb;
  --color-danger: #c0392b;
  --background: #ffffff;
  --text: #1b1f24;
  --radius: 10px;
  --font-sans: Inter, system-ui, sans-serif;
}
body { font-family: var(--font-sans); background: var(--background); color: var(--text); }
CSS
  cat > "$P/src/pages/OrdersPage.jsx" <<'JSX'
// Orders list (read-only today): number, customer, status. No search, no editing, no export yet.
export const OrdersPage = ({ orders }) => (
  <table>
    <thead><tr><th>Number</th><th>Customer</th><th>Status</th></tr></thead>
    <tbody>{orders.map((o) => <tr key={o.number}><td>{o.number}</td><td>{o.customer}</td><td>{o.status}</td></tr>)}</tbody>
  </table>
);
JSX
  cat > "$P/src/components/Button.jsx" <<'JSX'
export const Button = ({ children, ...props }) => <button className="btn" {...props}>{children}</button>;
JSX
  cat > "$P/README.md" <<'MD'
# Orders app (lab project)
A tiny order list used to try Praxis alpha.49. Managers should be able to see, search, edit the status of and export orders.
MD
  git -C "$P" init -q && git -C "$P" add -A && git -C "$P" -c user.email=lab@example.test -c user.name=lab commit -qm "Orders app: read-only list"
fi

# 3b. a copy for the alpha.48 upgrade check (create its work item with your NORMAL Claude first, see the guide)
if [ ! -d "$LAB/projects/orders-legacy/.git" ]; then cp -R "$P" "$LAB/projects/orders-legacy"; fi

# 4. three independent repositories for the multi-repository check
M="$LAB/projects/multi"
mkrepo() { # name, then files via heredoc functions below
  local dir="$M/$1"; mkdir -p "$dir"; shift
  if [ ! -d "$dir/.git" ]; then "$@" "$dir"; git -C "$dir" init -q && git -C "$dir" add -A && git -C "$dir" -c user.email=lab@example.test -c user.name=lab commit -qm "initial"; fi
}
backend() { mkdir -p "$1"; cat > "$1/package.json" <<'JSON'
{ "name": "orders-backend", "type": "module", "scripts": { "test": "node --test" } }
JSON
cat > "$1/orders.js" <<'JS'
export const orders = [
  { number: "A-1", customer: "Acme", status: "new" },
  { number: "B-2", customer: "Globex", status: "paid" },
  { number: "C-3", customer: "Initech", status: "shipped" },
];
export function listOrders() { return orders; }
JS
cat > "$1/orders.test.js" <<'JS'
import test from "node:test";
import assert from "node:assert";
import { listOrders } from "./orders.js";
test("lists orders", () => { assert.equal(listOrders().length, 3); });
JS
}
web() { mkdir -p "$1/src/pages"; cat > "$1/package.json" <<'JSON'
{ "name": "orders-web", "type": "module", "dependencies": { "react": "18.2.0" }, "scripts": { "test": "node --test" } }
JSON
cat > "$1/src/theme.css" <<'CSS'
:root { --color-primary: #0b6bcb; --radius: 8px; --font-sans: Inter, system-ui, sans-serif; }
CSS
cat > "$1/src/pages/Orders.jsx" <<'JSX'
export const Orders = () => null; // shows the orders list (to be built)
JSX
}
mobile() { mkdir -p "$1/src/screens"; cat > "$1/package.json" <<'JSON'
{ "name": "orders-mobile", "type": "module", "dependencies": { "react-native": "0.74.0" }, "scripts": { "test": "node --test" } }
JSON
cat > "$1/src/screens/Orders.js" <<'JS'
export const OrdersScreen = () => null; // shows the orders list (to be built)
JS
}
mkdir -p "$M"; mkrepo orders-backend backend; mkrepo orders-web web; mkrepo orders-mobile mobile

# 5. the ready-made interactive prototype command for the orders scenario (a file only; nothing in your projects is changed)
mkdir -p "$LAB/fixtures" && cp "$(dirname "$0")/orders-interactive-prototype.command.json" "$LAB/fixtures/"
echo "fixture: $LAB/fixtures/orders-interactive-prototype.command.json"
echo
echo "Lab ready: $LAB"
echo "Next: $(dirname "$0")/start-alpha49.sh orders-app     (or: multi)"
