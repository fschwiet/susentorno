#!/usr/bin/env bash
# Read-only diagnostics for the guest's isolation configuration.
#
# Usage: bash verify-config.sh [host-ip]
#   host-ip  Expected proxy host IP. If omitted, it is discovered from the
#            DHCP-supplied default route and reported. If given, the default
#            route and resolver are asserted to match it.
#
# Prints one PASS/FAIL/WARN line per check, with the observed value on failure.
# Exits non-zero if any check FAILs. WARN is advisory and never fails the run.
# Uses sudo for iptables reads. Makes real outbound requests to allow-listed
# hosts but never spends a real credential: gate.lua substitutes the real token
# only for an exact placeholder match, so the guest-supplied credential used
# below passes through and is rejected by the upstream.

set -uo pipefail # deliberately NOT -e: run every check even after a failure

pass=0
fail=0
warn=0

section() { printf '\n== %s ==\n' "$1"; }
ok() {
  pass=$((pass + 1))
  printf '  PASS  %s\n' "$1"
}
bad() {
  fail=$((fail + 1))
  if [ -n "${2:-}" ]; then printf '  FAIL  %s -- %s\n' "$1" "$2"; else printf '  FAIL  %s\n' "$1"; fi
}
adv() {
  warn=$((warn + 1))
  if [ -n "${2:-}" ]; then printf '  WARN  %s -- %s\n' "$1" "$2"; else printf '  WARN  %s\n' "$1"; fi
}

# curl an HTTP(S) URL and echo the observed status code; curl's exit code is left
# in $? for the caller to read.
curl_code() { curl -s -o /dev/null -w '%{http_code}' --max-time "$1" "$2"; }

PLACEHOLDER='sk-ant-oat-CONFIGAMATRON-PLACEHOLDER'

section 'Host IP'

# The host is the DHCP-supplied router, so the default route names it. This
# replaces reading the address out of the DNAT rules, which no longer exist.
route_ip="$(ip -4 route show default 2>/dev/null | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -n1)"
expected_ip="${1:-}"

if [ -n "$expected_ip" ]; then
  host_ip="$expected_ip"
  if [ "$route_ip" = "$expected_ip" ]; then
    ok "default route matches requested host IP ($host_ip)"
  else
    bad 'default route matches requested host IP' "requested $expected_ip, route points at '${route_ip:-none}'"
  fi
elif [ -n "$route_ip" ]; then
  host_ip="$route_ip"
  ok "discovered host IP from the default route: $host_ip"
else
  host_ip=''
  bad 'host IP determinable' 'no default route and no host-ip argument given -- did the adapter get a DHCP lease?'
fi

section 'CA trust (05)'

ca_src='/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt'
if [ -f "$ca_src" ]; then ok 'proxy CA installed'; else bad 'proxy CA installed' "missing $ca_src"; fi

if [ -e '/etc/ssl/certs/configamatron-proxy-certificate-authority.pem' ]; then
  ok 'proxy CA present in system trust bundle'
else
  bad 'proxy CA present in system trust bundle' 'no /etc/ssl/certs symlink -- did update-ca-certificates run?'
fi

node_ca="$(bash -lc 'echo $NODE_EXTRA_CA_CERTS')"
if printf '%s' "$node_ca" | grep -q 'configamatron-proxy-certificate-authority.crt'; then
  ok 'NODE_EXTRA_CA_CERTS set for login shells'
else
  bad 'NODE_EXTRA_CA_CERTS set for login shells' "got '${node_ca:-empty}'"
fi

# Firefox trusts only what its enterprise policy successfully imports, and the
# snap build imports nothing it cannot read from inside its sandbox (which
# shadows /usr/local) -- an unreadable Install path fails silently with
# SEC_ERROR_UNKNOWN_ISSUER on terminated hosts. So check the policy cert is
# current AND readable from within the confinement, not just present on disk.
ff_policy=/etc/firefox/policies/policies.json
ff_ca=/etc/firefox/policies/configamatron-proxy-certificate-authority.pem
if command -v firefox > /dev/null 2>&1 || snap list firefox > /dev/null 2>&1; then
  if [ -f "$ff_ca" ] && cmp -s "$ff_ca" "$ca_src"; then
    ok 'firefox policy cert matches installed proxy CA'
  else
    bad 'firefox policy cert matches installed proxy CA' "missing or stale $ff_ca -- re-run 05-configure-network.sh"
  fi

  if snap list firefox > /dev/null 2>&1 && [ -f "$ff_policy" ]; then
    while IFS= read -r cert; do
      [ -n "$cert" ] || continue
      if printf 'head -c1 "%s" >/dev/null 2>&1 && echo __READABLE__\nexit\n' "$cert" |
        snap run --shell firefox 2>/dev/null | grep -q __READABLE__; then
        ok "firefox snap can read policy cert $cert"
      else
        bad 'firefox snap can read policy cert' "$cert unreadable inside snap confinement -- Firefox will not import it"
      fi
    done < <(python3 -c 'import json,sys
try:
    data = json.load(open(sys.argv[1]))
    print("\n".join(data.get("policies", {}).get("Certificates", {}).get("Install", [])))
except Exception:
    pass' "$ff_policy")
  fi
else
  adv 'firefox CA checks' 'Firefox not found; skipped'
fi

section 'Host DNS (05)'

# Every name must resolve to the host: the responder there answers all A queries
# with its own address. A placeholder answer (the old in-guest dnsmasq stub
# returned 203.0.113.1) would mean a guest-side resolver survived the migration.
resolved="$(getent ahostsv4 example.com 2>/dev/null | awk '{print $1}' | head -n1)"
if [ -n "$host_ip" ] && [ "$resolved" = "$host_ip" ]; then
  ok "names resolve to the host ($resolved)"
else
  bad 'names resolve to the host' "example.com -> '${resolved:-none}', expected ${host_ip:-<host-ip>}"
fi

resolver_match=0
if [ -n "$host_ip" ]; then
  while IFS= read -r line; do
    case "$line" in
      *:*) ;;
      *) continue ;;
    esac
    servers="${line#*:}"
    for tok in $servers; do
      if [ "$tok" = "$host_ip" ]; then
        resolver_match=1
      fi
    done
  done <<EOF
$(resolvectl dns 2>/dev/null)
EOF
fi
if [ "$resolver_match" = 1 ]; then
  ok "resolver points at the host ($host_ip)"
else
  bad 'resolver points at the host' "resolvectl dns: $(resolvectl dns 2>/dev/null | tr '\n' ' ')"
fi

if ! systemctl is-active --quiet dnsmasq 2>/dev/null; then
  ok 'no in-guest dnsmasq (DNS is served by the host)'
else
  bad 'no in-guest dnsmasq' 'dnsmasq is still active -- remove it'
fi

section 'Routing (05)'

# The DNAT layer is gone: names already point at the proxy, so nothing needs
# redirecting. Any NAT rule here is a leftover from the old configuration.
nat_dump="$(sudo iptables -t nat -S OUTPUT 2>/dev/null || true)"
if ! printf '%s\n' "$nat_dump" | grep -q DNAT; then
  ok 'no DNAT rules (traffic goes straight to the proxy)'
else
  bad 'no DNAT rules' "$(printf '%s\n' "$nat_dump" | grep DNAT | tr '\n' ' ')"
fi

# The route arrives via DHCP now, rather than being installed by a systemd unit,
# and it is the same on both networks -- which is what makes switching between
# them a purely host-side operation.
route="$(ip -4 route show default 2>/dev/null)"
if [ -z "$route" ]; then
  bad 'default route present' 'no default route -- did the adapter get a DHCP lease?'
elif [ -n "$host_ip" ] && printf '%s' "$route" | grep -q "via $host_ip"; then
  ok "default route via the host ($host_ip)"
else
  adv 'default route via the host' "unexpected route: $(printf '%s' "$route" | head -n1)"
fi

if ! systemctl is-active --quiet configamatron-egress.service 2>/dev/null; then
  ok 'no configamatron-egress.service (routing comes from DHCP)'
else
  bad 'no configamatron-egress.service' 'the egress unit is still active -- remove it'
fi

section 'Placeholder credential'

cred="$HOME/.claude/.credentials.json"
if [ ! -f "$cred" ]; then
  bad 'placeholder credential in place' "missing $cred -- run 06-auth-config.sh to link vm-shared/credentials.json"
elif grep -q "$PLACEHOLDER" "$cred"; then
  ok 'credentials.json is the placeholder'
else
  bad 'credentials.json is the placeholder' 'a NON-placeholder token is present in the VM -- a real credential must never live here'
fi

section 'Live egress'

c="$(curl_code 20 http://archive.ubuntu.com/)" && [ "$c" -lt 400 ] 2>/dev/null && ok "allow-listed :80 archive.ubuntu.com -> $c" || bad 'allow-listed :80 archive.ubuntu.com' "code=$c curlExit=$?"

c="$(curl_code 30 https://pypi.org/)" && [ "$c" -lt 400 ] 2>/dev/null && ok "allow-listed passthrough :443 pypi.org -> $c" || bad 'allow-listed passthrough :443 pypi.org' "code=$c curlExit=$?"

if curl -s -o /dev/null --max-time 20 https://blocked.example.com/; then
  bad 'blocked :443 connection dropped' 'curl succeeded; expected a connection failure'
else
  ok "blocked :443 connection dropped (curlExit=$?)"
fi

c="$(curl_code 20 http://blocked.example.com/)"
if [ "$c" = '403' ]; then ok 'blocked :80 -> 403 (default deny)'; else bad 'blocked :80 default deny' "expected 403, got $c"; fi

# gate.lua swaps ONLY an exact placeholder match for the real token; any other
# Authorization passes through to the upstream unmodified (it no longer 403s an
# unexpected credential -- see docs/investigations/2026-07-22-remote-control-session-
# token-rejected-by-claude-gate.md). So a guest-supplied credential must reach the
# upstream and be REJECTED there.
#
# /v1/models, not "/": "/" answers 404 whatever the credential, so it cannot tell a
# rejected credential from an injected one. Asserting >=400 rather than a specific
# code keeps this robust to upstream changes -- the outcome that must never happen is
# a 2xx, which would mean the real token had been substituted for a guest's own.
c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -H 'Authorization: Bearer not-the-placeholder' -H 'anthropic-version: 2023-06-01' \
  https://api.anthropic.com/v1/models)"
if [ -z "$c" ] || [ "$c" = '000' ]; then
  bad 'credential gate wrong-auth' "no response from upstream (code=$c)"
elif [ "$c" -lt 400 ] 2>/dev/null; then
  bad 'credential gate wrong-auth' "got $c -- a guest-supplied credential was upgraded; the real token must never be substituted"
else
  ok "credential gate: guest credential passed through and rejected upstream ($c)"
fi

printf '\n%d passed, %d failed, %d warnings\n' "$pass" "$fail" "$warn"
[ "$fail" -eq 0 ]
