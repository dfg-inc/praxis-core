#!/bin/bash
# Runs as root INSIDE a Linux container (a real Linux kernel with real uid separation). Sets up the world, then flow.mjs does the checks.
set -eu
[ "$(id -u)" = 0 ]
useradd -m agent
install -d -o agent -g agent -m 0755 /home/agent
runuser -u agent -- sh -c 'cd /home/agent && git init -q -b main repo && git -C repo config user.name Agent && git -C repo config user.email agent@example.invalid && echo seed > repo/README.md && git -C repo add README.md && git -C repo commit -q -m seed && git init -q --bare -b main remote.git && git -C repo remote add origin /home/agent/remote.git'
# What the owner's per-repository step does (INSTALL.md step 5): let the service identity write to the repository's .git and the remote.
chmod -R a+rwX /home/agent/repo/.git /home/agent/remote.git

cd /pkg/* && sh install.sh check
sh install.sh install
cat > /etc/praxis-approval/config.json <<JSON
{
  "mode": "production",
  "principal": "praxis-approval",
  "repositories": [ { "path": "/home/agent/repo", "remotes": { "origin": "/home/agent/remote.git" }, "branches": ["*"], "provider": { "kind": "fixture", "instanceId": "fixture/demo" } } ],
  "providers": { "fixture": { "instances": { "fixture/demo": { "actions": ["create_merge_request"] } } } },
  "operator": { "port": 8780, "origin": "http://localhost:8780" }
}
JSON
chown root:root /etc/praxis-approval/config.json && chmod 0644 /etc/praxis-approval/config.json
install -d -o praxis-approval -g praxis-approval -m 0755 /run/praxis-approval
exec node /core/tools/approval-service/acceptance/flow.mjs
