#!/bin/bash
# macOS acceptance of the INSTALLED Approval Service. Run as your ordinary user (the one the AI agent runs as).
# This script never uses sudo and never changes accounts or credentials. Steps that need an administrator or a person
# are printed as instructions, not run. It writes only inside ~/praxis-acceptance (a throwaway test repository).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CORE="${PRAXIS_CORE:-$(cd "$HERE/../../../.." && pwd)}"
NODE="${PRAXIS_NODE:-$(command -v node)}"
WORK="$HOME/praxis-acceptance"
REPO="$WORK/repo"
REMOTE="$WORK/remote.git"
BASE="/Library/Application Support/Praxis/ApprovalService"
[ -f "$CORE/packages/contracts/dist/index.js" ] || { echo "PRAXIS_CORE must point at the built praxis-core checkout (packages/contracts/dist/index.js not found under $CORE)"; exit 2; }
export PRAXIS_CORE="$CORE"
client() { "$NODE" "$HERE/client.mjs" "$@"; }
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILED=1; }
FAILED=0
denied() { # denied "<description>" command...   passes when the command FAILS
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then fail "$d (the command SUCCEEDED, it must be denied)"; else pass "$d"; fi
}

case "${1:-}" in
setup-repo)  # isolated test repository and bare remote; no production credentials, no network
  mkdir -p "$WORK"; rm -rf "$REPO" "$REMOTE"
  git init -q -b main "$REPO"; git -C "$REPO" config user.name "Acceptance Agent"; git -C "$REPO" config user.email "agent@example.invalid"
  echo "# acceptance fixture" > "$REPO/README.md"; git -C "$REPO" add README.md; git -C "$REPO" commit -q -m "seed"
  git init -q --bare -b main "$REMOTE"; git -C "$REPO" remote add origin "$REMOTE"
  git -C "$REPO" push -q origin main
  echo "Test repository: $REPO   remote: $REMOTE"
  echo "Now (administrator): node $CORE/tools/approval-service/praxis-approval-service.mjs allow-repo \"$REPO\" --remote \"$REMOTE\"  and follow its two steps" ;;
a-identity)  # A: the service runs under its own OS identity
  echo "--- run these as an administrator and compare:"
  echo "  dscl . -read /Users/_praxisapproval UserShell NFSHomeDirectory IsHidden Password UniqueID PrimaryGroupID"
  echo "  id _praxisapproval          (must list only its own group; never 'admin')"
  echo "  ps -axo user,pid,command | grep '[p]raxis-approval-service.mjs'   (user column must be _praxisapproval)"
  echo "  sudo launchctl print system/co.praxis.approval-service | grep -E 'state|pid|path|program'"
  echo "--- as yourself:"
  PID_USER="$(ps -axo user,command | grep '[p]raxis-approval-service.mjs run' | awk '{print $1}' | head -n1)"
  [ "$PID_USER" = "_praxisapproval" ] && pass "the service process runs as _praxisapproval" || fail "service process user is '$PID_USER'"
  [ "$(stat -f %Su "$BASE/run/service.sock" 2>/dev/null)" = "_praxisapproval" ] && pass "the socket belongs to _praxisapproval" || fail "socket owner"
  client assess | tee /tmp/assess.json | grep -E '"isolated"|"reasons"' ; grep -q '"isolated": true' /tmp/assess.json && pass "the agent-side client judges the service isolated" || fail "assessApprovalService does not report isolated"
  client health | grep -E '"mode"|"verified"|"ok"' | head -8 ;;
b-denials)  # B: what the agent (you) must not be able to do
  denied "read the signing key"                       cat "$BASE/state/trusted/private.pem"
  denied "list the state directory"                    ls "$BASE/state"
  denied "append to the audit log"                     sh -c "echo x >> '$BASE/state/audit/chain.jsonl'"
  denied "write the ledger"                            sh -c "echo x > '$BASE/state/ledger/c-x.json'"
  denied "read the enrollment code file"               cat "$BASE/state/trusted/enroll.json"
  denied "plant an authorization token"                mkdir "$BASE/state/shared/authorizations/x"
  denied "change the privileged configuration"         sh -c "echo x >> '$BASE/config.json'"
  denied "replace the service script"                  sh -c "echo x >> '$BASE/code/praxis-approval-service.mjs'"
  denied "replace the bundled Node"                    sh -c "echo x >> '$BASE/code/node/bin/node'"
  denied "replace the launchd plist"                   sh -c "echo x >> /Library/LaunchDaemons/co.praxis.approval-service.plist"
  denied "remove the socket"                           rm -f "$BASE/run/service.sock"
  denied "rename the socket"                           mv "$BASE/run/service.sock" "$BASE/run/service.sock.x"
  denied "signal the service process"                  sh -c "kill \$(pgrep -f 'praxis-approval-service.mjs run' | head -n1)"
  denied "read backups"                                ls "$BASE/backups"
  denied "read service logs"                           cat /var/log/praxis-approval/service.log
  R="$(client raw '{"protocol":"praxis.approval-service.v1","op":"approve","requestId":"x"}')"; echo "$R" | grep -q UNKNOWN_OPERATION && pass "the IPC has no approve operation" || fail "approve was not refused as an unknown operation: $R"
  echo "--- the user can still do the intended things:"; client health | grep -q '"ok": true' && pass "health is readable" || fail "health" ;;
c-docker)  # C: Docker control must not give the Broker's authority
  command -v docker >/dev/null || { echo "docker not installed: record 'not applicable'"; exit 0; }
  docker info >/dev/null 2>&1 || { echo "Docker Desktop is not running: start it, then re-run"; exit 0; }
  for p in "$BASE/state" "$BASE/code" "$BASE" "/Library/Application Support/Praxis" "/var/log/praxis-approval" "/private/var/db/dslocal"; do
    OUT="$(docker run --rm -v "$p:/mnt:ro" alpine sh -c 'ls -la /mnt 2>&1 | head -5; cat /mnt/trusted/private.pem 2>&1 | head -1' 2>&1)"
    if echo "$OUT" | grep -q "BEGIN"; then fail "docker read the key through $p"; else pass "docker bind of '$p' did not expose the key"; fi
    echo "      observed: $(echo "$OUT" | tr '\n' ' ' | cut -c1-200)"
  done
  OUT="$(docker run --rm --privileged --pid=host alpine sh -c 'ls /host_mnt 2>&1 | head -3; find / -name private.pem 2>/dev/null | head -2' 2>&1)"
  echo "$OUT" | grep -q private.pem && fail "a privileged container found a private.pem: $OUT" || pass "a privileged container in the Docker VM found no signing key"
  echo "--- through the socket Docker can reach only what you can: IPC, no approval"
  R="$(docker run --rm -v "$BASE/run/service.sock:/s.sock" alpine sh -c 'echo "{\"protocol\":\"praxis.approval-service.v1\",\"op\":\"approve\",\"requestId\":\"x\"}" | nc -U /s.sock' 2>&1)"; echo "      observed: $R" | cut -c1-240
  echo "RECORD the real output above in MACOS-ACCEPTANCE-RESULTS.md: a Docker VM is a separate trust domain and must be observed, not assumed." ;;
d-enroll)
  echo "As an administrator, open a 15 minute enrollment window as the service identity:"
  echo "  sudo -u _praxisapproval \"$BASE/code/node/bin/node\" \"$BASE/code/praxis-approval-service.mjs\" enroll-code --config \"$BASE/config.json\""
  echo "Then open http://localhost:8780/enroll in Safari or Chrome on THIS Mac, type the code, and complete the Touch ID prompt."
  echo "Expected: 'Enrolled. Enrollment is now closed.' A second attempt with the same code must say the window is closed."
  echo "After enrolling: client health | grep enrolledAuthenticators   (must be 1)"; client health | grep -E 'enrolledAuthenticators' ;;
submit-commit)  # starting point for E, F, G
  [ -d "$REPO/.git" ] || { echo "run setup-repo first"; exit 1; }
  N="${2:-1}"; echo "change $N $(date +%s)" > "$REPO/accept-$N.txt"
  export EXECUTION_ID="ex-accept-$N"
  client submit-commit "$REPO" "acceptance commit $N" "accept-$N.txt" | tee "/tmp/accept-$N.json"
  echo "Open the operatorUrl above, check the page shows: work item WI-ACCEPTANCE, the repository, branch acceptance/touch-id, the file accept-$N.txt, the commit message, the fingerprint, the expiry, 'reversible'."
  echo "Then: acceptance.sh decide-hint $N" ;;
decide-hint) echo "On the operator page press REJECT (step E) or APPROVE (step F) and complete Touch ID. Then run: acceptance.sh execute ${2:-1}" ;;
execute)
  N="${2:-1}"; ID="$(grep -o '"requestId": *"[^"]*"' "/tmp/accept-$N.json" | head -1 | sed 's/.*: *"//;s/"//')"
  BEFORE="$(git -C "$REPO" rev-parse HEAD)"; client execute "$ID" | tee "/tmp/accept-$N.exec.json"
  AFTER="$(git -C "$REPO" rev-parse HEAD)"; echo "HEAD before: $BEFORE"; echo "HEAD after:  $AFTER"
  [ "$BEFORE" = "$AFTER" ] && echo "(HEAD unchanged)" || { echo "commits added:"; git -C "$REPO" log --format='%h %an %s' "$BEFORE..$AFTER"; } ;;
e-expect)  echo "E (REJECT): after rejecting, execute must print APPROVAL_REJECTED and HEAD must be unchanged, 'git -C $REPO status' must show the file untracked and nothing staged." ;;
f-expect)  echo "F (APPROVE): after approving with Touch ID, execute must report state completed, exactly ONE new commit authored by 'Praxis Approval Service' containing only accept-N.txt (git show --stat)." ;;
g-replay)  # G1
  export EXECUTION_ID="ex-accept-${2:-1}"; B="$(git -C "$REPO" rev-parse HEAD)"
  echo "same execution id after the commit: expect state completed, the SAME commit, no new commit"
  client submit-commit "$REPO" "acceptance commit ${2:-1}" "accept-${2:-1}.txt"
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$B" ] && pass "no second commit" || fail "HEAD moved on replay"
  echo "same id, different message: expect CHANGED_PLAN"
  client submit-commit "$REPO" "a different message" "accept-${2:-1}.txt" ;;
g-modified)  # G2
  echo "1) acceptance.sh submit-commit 7   2) approve on the page   3) modify the file BEFORE executing:  echo tampered >> $REPO/accept-7.txt   4) acceptance.sh execute 7"
  echo "Expected: APPROVAL_SCOPE_MISMATCH and no new commit. Restore the file ('echo ... > accept-7.txt' with the original text) and execute again: it works, the approval was not burned." ;;
g-expired)  # G3
  echo "As an administrator set \"planTtlMs\": 30000 in $BASE/config.json, then: sudo launchctl kickstart -k system/co.praxis.approval-service"
  echo "1) acceptance.sh submit-commit 8   2) approve   3) wait 40 seconds   4) acceptance.sh execute 8"
  echo "Expected: APPROVAL_EXPIRED (or REQUIRED), no commit. Then remove planTtlMs and restart the service again." ;;
h-clean)  # H
  cd "$REPO" || exit 1
  REFS="$(git for-each-ref --format='%(refname)')"; echo "$REFS"
  echo "$REFS" | grep -Eiq 'approv|token|ledger|authoriz' && fail "an approval-looking ref exists" || pass "no approval branches or refs"
  git ls-files | grep -Eiq 'approv|token|ledger|authoriz|\.pem|secret' && fail "an approval/secret-looking tracked file exists" || pass "no approval or secret files tracked"
  git log --all -p | grep -Eq 'BEGIN (EC |RSA |OPENSSH )?PRIVATE KEY' && fail "private key text in history" || pass "no private key text in any commit"
  git status --porcelain | sed 's/^/      status: /'
  grep -rIl 'authorizations\|private.pem' "$REPO" --exclude-dir=.git 2>/dev/null | head -3 | sed 's/^/      mentions: /'
  echo "branches: $(git branch --list | tr '\n' ' ')   (only acceptance/touch-id and main are expected)" ;;
i-reboot)
  echo "Reboot the Mac, log in, then run:"
  echo "  sudo \"$BASE/code/ctl.sh\" health          (production, isolation verified, integrity ok)"
  echo "  acceptance.sh a-identity; acceptance.sh g-replay 1     (the recorded commit result must still be returned: the ledger survived)"
  echo "The service must be running BEFORE you log in a second time (LaunchDaemon, not LaunchAgent): check 'ps' right after boot at the login window if you can." ;;
j-rollback)
  echo "As an administrator:"
  echo "  sudo \"$BASE/code/ctl.sh\" backup"
  echo "  sudo \"$BASE/code/ctl.sh\" rollback            (needs a previous backup; take one by installing the package twice or running backup first)"
  echo "  sudo \"$BASE/code/ctl.sh\" health"
  echo "  sudo \"$BASE/code/ctl.sh\" uninstall            (state kept)  then verify: ls \"$BASE\"   dscl . -read /Users/_praxisapproval (still there)"
  echo "  sudo \"$BASE/code/ctl.sh\" uninstall --purge    (state and account removed) then: dscl . -read /Users/_praxisapproval (must FAIL: account gone), ls /Library/LaunchDaemons | grep praxis (nothing)"
  echo "Backups stay in $BASE/backups (root only) unless you delete them." ;;
*) echo "usage: acceptance.sh setup-repo|a-identity|b-denials|c-docker|d-enroll|submit-commit [N]|execute [N]|g-replay [N]|g-modified|g-expired|h-clean|i-reboot|j-rollback"; exit 2 ;;
esac
[ "$FAILED" = 0 ] || { echo "RESULT: FAILED"; exit 1; }
