# --- shared by preinstall, postinstall and ctl.sh (inlined at build time; not a script of its own) --------------------------
# Path safety, account validation and permission reporting. Everything here is read-only except where a function says so.

psec_fail() { echo "praxis-approval-service: $*" >&2; exit 1; }

# The permission digits of a path (last three of the octal mode), as g and o.
psec_mode() { stat -f %Lp "$1"; }
psec_gw() { m="$(printf '%04d' "$(psec_mode "$1")")"; g="$(printf '%s' "$m" | cut -c3)"; o="$(printf '%s' "$m" | cut -c4)"; case "$g$o" in *[2367]*) return 0 ;; esac; return 1; }

# Prints the first ACL entry that grants anyone write-like access to $1 (deny entries are ignored). Empty when there is none.
psec_acl_problem() {
  ls -lde "$1" 2>/dev/null | awk 'NR > 1 && / allow / && /(write|append|add_file|add_subdirectory|delete|delete_child|writeattr|writeextattr|writesecurity|chown)/ { print; exit }'
}

# One existing path component that must be part of a root-controlled chain: not a link (a dangling link included), owned by
# root, not writable by group or others, no write-like ACL entry. A component that does not exist is not a violation
# (the installer creates it), but a link that points nowhere is.
psec_check_component() {
  p="$1"
  if [ -L "$p" ]; then
    if [ -e "$p" ]; then psec_fail "$p is a symbolic link; refusing"; else psec_fail "$p is a dangling symbolic link; refusing"; fi
  fi
  [ -e "$p" ] || return 0
  [ "$(stat -f %u "$p")" = 0 ] || psec_fail "$p is not owned by root; refusing"
  if psec_gw "$p"; then psec_fail "$p is writable by group or others ($(psec_mode "$p")); refusing"; fi
  a="$(psec_acl_problem "$p")"
  [ -z "$a" ] || psec_fail "$p has an ACL entry that grants write access ($a); refusing"
}

# Every component of $1 from / downward must pass psec_check_component (the path itself included).
psec_assert_chain() {
  full="$1"; cur=""; oldifs="$IFS"
  psec_check_component "/"
  set -f; IFS=/
  for part in ${full#/}; do
    cur="$cur/$part"
    IFS="$oldifs"; psec_check_component "$cur"; IFS=/
  done
  IFS="$oldifs"; set +f
}

# A directory the service or the installer owns beneath the root-controlled chain: $1 = path, $2 = allowed owner uid besides root
# (may be empty). Not a link, owner root or $2, no group/other write, no write-like ACL entry.
psec_assert_leaf() {
  p="$1"; allowed="${2:-}"
  if [ -L "$p" ]; then
    if [ -e "$p" ]; then psec_fail "$p is a symbolic link; refusing"; else psec_fail "$p is a dangling symbolic link; refusing"; fi
  fi
  [ -e "$p" ] || return 0
  owner="$(stat -f %u "$p")"
  if [ "$owner" != 0 ] && { [ -z "$allowed" ] || [ "$owner" != "$allowed" ]; }; then psec_fail "$p is owned by uid $owner; refusing"; fi
  if psec_gw "$p"; then psec_fail "$p is writable by group or others ($(psec_mode "$p")); refusing"; fi
  a="$(psec_acl_problem "$p")"
  [ -z "$a" ] || psec_fail "$p has an ACL entry that grants write access ($a); refusing"
}

# Everything under $1 (the code directory): no links, nothing writable by group or others, no write-like ACL entry.
psec_assert_tree() {
  root="$1"
  [ -z "$(find "$root" -type l -print -quit 2>/dev/null)" ] || psec_fail "$(find "$root" -type l -print -quit) is a symbolic link inside the code directory; refusing"
  [ -z "$(find "$root" ! -type f ! -type d -print -quit 2>/dev/null)" ] || psec_fail "$(find "$root" ! -type f ! -type d -print -quit) is not a plain file or directory; refusing"
  notroot="$(find "$root" -exec stat -f '%u %N' {} + 2>/dev/null | awk '$1 != 0 { print; exit }')"
  [ -z "$notroot" ] || psec_fail "an entry inside $root is not owned by root ($notroot); refusing"
  [ -z "$(find "$root" -perm -0020 -print -quit 2>/dev/null)" ] || psec_fail "$(find "$root" -perm -0020 -print -quit) is writable by group; refusing"
  [ -z "$(find "$root" -perm -0002 -print -quit 2>/dev/null)" ] || psec_fail "$(find "$root" -perm -0002 -print -quit) is writable by others; refusing"
  [ -z "$(find "$root" \( -perm -4000 -o -perm -2000 \) -print -quit 2>/dev/null)" ] || psec_fail "$(find "$root" \( -perm -4000 -o -perm -2000 \) -print -quit) has a set-id bit; refusing"
  bad="$(ls -leR "$root" 2>/dev/null | awk '/^ [0-9]+: / && / allow / && /(write|append|add_file|add_subdirectory|delete|delete_child|writeattr|writeextattr|writesecurity|chown)/ { print; exit }')"
  [ -z "$bad" ] || psec_fail "an entry inside $root has an ACL that grants write access ($bad); refusing"
}

# --- the service account -----------------------------------------------------------------------------------------------------
ACCT="_praxisapproval"
ACCT_REALNAME="Praxis Approval Service"

# One attribute of a directory record, or nothing. Real `dscl -read` formats (all seen on macOS):
#   UniqueID: 206                               standard attribute, value on the key line
#   dsAttrTypeNative:IsHidden: 1                native attribute: the key carries a dsAttrTypeNative: prefix
#   dsAttrTypeStandard:RealName: X              the same prefix form for standard attributes
#   RealName:\n Praxis Approval Service         value on the following line(s), one leading space each
#   No such key: X                              missing attribute (exit status 0)
dget() {
  out="$(dscl . -read "$1" "$2" 2>/dev/null)" || return 0
  case "$out" in ''|'No such key'*) return 0 ;; esac
  printf '%s\n' "$out" | awk -v k="$2" '
    NR == 1 {
      line = $0
      sub(/^dsAttrType(Native|Standard):/, "", line)
      if (index(line, k ":") == 1) line = substr(line, length(k) + 2)
      else { exit }            # the first line is not this attribute: no value
      v = line
    }
    NR > 1 { v = v " " $0 }
    END { print v }' | sed 's/^ *//; s/ *$//; s/  */ /g'
}
acct_user_exists() { dscl . -read "/Users/$ACCT" >/dev/null 2>&1; }
acct_group_exists() { dscl . -read "/Groups/$ACCT" >/dev/null 2>&1; }
# a directory listing that fails is a failure, never "nobody uses this id"
acct_count_uid() { out="$(dscl . -list /Users UniqueID 2>/dev/null)" || psec_fail "cannot list the accounts (dscl failed); refusing"; printf '%s\n' "$out" | awk -v id="$1" '$2 == id { n++ } END { print n + 0 }'; }
acct_count_gid() { out="$(dscl . -list /Groups PrimaryGroupID 2>/dev/null)" || psec_fail "cannot list the groups (dscl failed); refusing"; printf '%s\n' "$out" | awk -v id="$1" '$2 == id { n++ } END { print n + 0 }'; }

# Decides what is on this Mac: prints absent | group-only | user-only | complete, and exits (refusing) for anything that is not
# provably ours or is in conflict. It only reads. A name match alone never makes an account acceptable.
acct_validate() {
  ug=0; uu=0
  acct_group_exists && ug=1
  acct_user_exists && uu=1
  if [ "$ug$uu" = 00 ]; then echo absent; return 0; fi
  if [ "$ug" = 1 ]; then
    [ "$(dget "/Groups/$ACCT" RealName)" = "$ACCT_REALNAME" ] || psec_fail "a group named $ACCT exists but was not created by this installer (RealName is '$(dget "/Groups/$ACCT" RealName)'); refusing"
    ggid="$(dget "/Groups/$ACCT" PrimaryGroupID)"
    case "$ggid" in ''|*[!0-9]*) psec_fail "group $ACCT has no numeric PrimaryGroupID; refusing" ;; esac
    { [ "$ggid" -ge 1 ] && [ "$ggid" -lt 500 ]; } || psec_fail "group $ACCT has GID $ggid, outside the system range 1-499; refusing"
    [ "$(acct_count_gid "$ggid")" = 1 ] || psec_fail "GID $ggid is used by more than one group; refusing"
    # nobody else may be a member of the service's group (the logs are readable by it), nested or by GUID included
    for key in GroupMembership GroupMembers NestedGroups; do
      members="$(dget "/Groups/$ACCT" "$key")"
      for m in $members; do [ "$m" = "$ACCT" ] || psec_fail "group $ACCT has another member or nested group in $key ($m); refusing"; done
    done
  fi
  if [ "$uu" = 1 ]; then
    [ "$(dget "/Users/$ACCT" RealName)" = "$ACCT_REALNAME" ] || psec_fail "an account named $ACCT exists but was not created by this installer (RealName is '$(dget "/Users/$ACCT" RealName)'); refusing"
    uid="$(dget "/Users/$ACCT" UniqueID)"
    case "$uid" in ''|*[!0-9]*) psec_fail "account $ACCT has no numeric UniqueID; refusing" ;; esac
    { [ "$uid" -ge 1 ] && [ "$uid" -lt 500 ]; } || psec_fail "account $ACCT has UID $uid, outside the system range 1-499; refusing"
    [ "$(acct_count_uid "$uid")" = 1 ] || psec_fail "UID $uid is used by more than one account; refusing"
    pgid="$(dget "/Users/$ACCT" PrimaryGroupID)"
    case "$pgid" in ''|*[!0-9]*) psec_fail "account $ACCT has no numeric PrimaryGroupID; refusing" ;; esac
    [ "$pgid" = "$uid" ] || psec_fail "account $ACCT has UID $uid but primary group $pgid; refusing"
    [ "$(acct_count_gid "$pgid")" -le 1 ] || psec_fail "GID $pgid is used by more than one group; refusing"
    if [ "$ug" = 1 ]; then [ "$pgid" = "$ggid" ] || psec_fail "account $ACCT has primary group $pgid but group $ACCT is $ggid; refusing"; fi
    # attributes that may be MISSING after an interrupted installation are completed later; attributes that are present must be right
    sh_="$(dget "/Users/$ACCT" UserShell)";            [ -z "$sh_" ] || [ "$sh_" = /usr/bin/false ] || psec_fail "account $ACCT has login shell '$sh_'; refusing"
    hm_="$(dget "/Users/$ACCT" NFSHomeDirectory)";    [ -z "$hm_" ] || [ "$hm_" = /var/empty ] || psec_fail "account $ACCT has home directory '$hm_'; refusing"
    hd_="$(dget "/Users/$ACCT" IsHidden)";            [ -z "$hd_" ] || [ "$hd_" = 1 ] || psec_fail "account $ACCT is not hidden; refusing"
    pw_="$(dget "/Users/$ACCT" Password)";            [ -z "$pw_" ] || [ "$pw_" = '*' ] || psec_fail "account $ACCT has a password set; refusing"
    [ -z "$(dget "/Users/$ACCT" AuthenticationAuthority)" ] || psec_fail "account $ACCT has an authentication authority (it could log in); refusing"
    dsmemberutil checkmembership -U "$ACCT" -G admin 2>&1 | grep -q 'is not a member' || psec_fail "account $ACCT is a member of the admin group; refusing"
    [ -z "$(dscl . -search /Groups GroupMembership "$ACCT" 2>/dev/null)" ] || psec_fail "account $ACCT is a member of another group; refusing"
  fi
  if [ "$ug$uu" = 11 ]; then echo complete; elif [ "$ug" = 1 ]; then echo group-only; else echo user-only; fi
}

# --- reporting the permissions of what the installation created (used by postinstall and `ctl.sh verify`) ----------------------------
# perm_expect <path> <owner-name> <mode> : prints PASS/FAIL, returns non-zero on FAIL
perm_expect() {
  p="$1"; want_owner="$2"; want_mode="$3"
  if [ -L "$p" ]; then echo "FAIL  $p is a symbolic link"; return 1; fi
  if [ ! -e "$p" ]; then echo "FAIL  $p is missing"; return 1; fi
  have_owner="$(stat -f %Su "$p")"; have_mode="$(psec_mode "$p")"
  a="$(psec_acl_problem "$p")"
  if [ "$have_owner" = "$want_owner" ] && [ "$have_mode" = "$want_mode" ] && [ -z "$a" ]; then echo "PASS  $p  $have_owner $have_mode"; return 0; fi
  echo "FAIL  $p  is $have_owner $have_mode${a:+ with ACL entry '$a'}, expected $want_owner $want_mode and no write ACL"
  return 1
}

# version_gt A B : succeeds when A is a strictly newer version than B (x.y.z, optional -prerelease: a release is newer than its pre-releases)
version_gt() {
  awk -v a="$1" -v b="$2" '
    function core(v,   p) { p = index(v, "-"); return p ? substr(v, 1, p - 1) : v }
    function pre(v,   p) { p = index(v, "-"); return p ? substr(v, p + 1) : "" }
    function cmpid(x, y) { if (x ~ /^[0-9]+$/ && y ~ /^[0-9]+$/) return (x + 0 > y + 0) - (x + 0 < y + 0); return (x > y) - (x < y) }
    BEGIN {
      na = split(core(a), ca, "."); nb = split(core(b), cb, "."); n = na > nb ? na : nb
      for (i = 1; i <= n; i++) { r = cmpid(ca[i] + 0 "", cb[i] + 0 ""); if (r) exit (r > 0 ? 0 : 1) }
      pa = pre(a); pb = pre(b)
      if (pa == pb) exit 1
      if (pa == "") exit 0
      if (pb == "") exit 1
      na = split(pa, xa, "."); nb = split(pb, xb, "."); n = na > nb ? na : nb
      for (i = 1; i <= n; i++) {
        if (xa[i] == "") exit 1
        if (xb[i] == "") exit 0
        r = cmpid(xa[i], xb[i]); if (r) exit (r > 0 ? 0 : 1)
      }
      exit 1
    }'
}
