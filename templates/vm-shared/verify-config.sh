#!/usr/bin/env bash
# Read-only diagnostics for the sandbox VM's isolation configuration.
#
# Usage: bash verify-config.sh [host-ip]
#   host-ip  Expected proxy host IP. If omitted, it is discovered from the
#            installed DNAT rules and reported. If given, the installed rules and
#            default route are asserted to match it.
#
# Prints one PASS/FAIL/WARN line per check, with the observed value on failure.
# Exits non-zero if any check FAILs. WARN is advisory and never fails the run.
# Uses sudo for iptables reads. Makes real outbound requests to allow-listed
# hosts but never spends a real credential (wrong-auth to api.anthropic.com is
# rejected locally by gate.lua with 403).

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

PLACEHOLDER='sk-ant-oat-SANDBOX-PLACEHOLDER'
STUB_IP='203.0.113.1'

section 'Host IP'

nat_dump="$(sudo iptables -t nat -S OUTPUT 2>/dev/null || true)"
dnat_ip="$(printf '%s\n' "$nat_dump" | sed -n 's/.*--dport 443 -j DNAT --to-destination \([0-9.]*\):443.*/\1/p' | head -n1)"
expected_ip="${1:-}"

if [ -n "$expected_ip" ]; then
  host_ip="$expected_ip"
  if [ "$dnat_ip" = "$expected_ip" ]; then
    ok "DNAT target matches requested host IP ($host_ip)"
  else
    bad 'DNAT target matches requested host IP' "requested $expected_ip, rules point at '${dnat_ip:-none}'"
  fi
elif [ -n "$dnat_ip" ]; then
  host_ip="$dnat_ip"
  ok "discovered host IP from DNAT rules: $host_ip"
else
  host_ip=''
  bad 'host IP determinable' 'no DNAT rule found and no host-ip argument given -- has 07-setup-persistence.sh run?'
fi

section 'CA trust (06)'

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

section 'DNS stub (07)'

if [ "$(systemctl is-active dnsmasq 2>/dev/null)" = 'active' ]; then ok 'dnsmasq active'; else bad 'dnsmasq active' "is-active=$(systemctl is-active dnsmasq 2>/dev/null)"; fi
if [ "$(systemctl is-enabled dnsmasq 2>/dev/null)" = 'enabled' ]; then ok 'dnsmasq enabled at boot'; else bad 'dnsmasq enabled at boot' "is-enabled=$(systemctl is-enabled dnsmasq 2>/dev/null)"; fi

if ! command -v dig >/dev/null 2>&1; then
  adv 'dns resolution checks' 'dig not installed (dnsutils); skipping DNS answer checks'
else
  stub_direct="$(dig +short example.com @127.0.0.1 2>/dev/null | head -n1)"
  if [ "$stub_direct" = "$STUB_IP" ]; then ok "stub answers example.com -> $STUB_IP"; else bad 'stub answers via 127.0.0.1' "got '${stub_direct:-none}', want $STUB_IP"; fi

  stub_eff="$(dig +short example.com 2>/dev/null | head -n1)"
  if [ "$stub_eff" = "$STUB_IP" ]; then ok "stub is the effective resolver (example.com -> $STUB_IP)"; else bad 'stub is the effective resolver' "got '${stub_eff:-none}', want $STUB_IP"; fi
fi

if resolvectl dns 2>/dev/null | grep -q '127.0.0.1'; then
  ok 'resolvectl lists 127.0.0.1 as a resolver'
else
  bad 'resolvectl lists 127.0.0.1 as a resolver' 'netplan DNS override not applied?'
fi

section 'Routing / NAT (07)'

if printf '%s\n' "$nat_dump" | grep -q -- "--dport 443 -j DNAT --to-destination ${host_ip}:443"; then
  ok 'DNAT rule for :443 present'
else
  bad 'DNAT rule for :443 present' "no rule to ${host_ip:-<host-ip>}:443"
fi
if printf '%s\n' "$nat_dump" | grep -q -- "--dport 80 -j DNAT --to-destination ${host_ip}:80"; then
  ok 'DNAT rule for :80 present'
else
  bad 'DNAT rule for :80 present' "no rule to ${host_ip:-<host-ip>}:80"
fi

route="$(ip -4 route show default 2>/dev/null)"
if [ -z "$route" ]; then
  bad 'default route present' 'no default route (host-only mode needs the unit-installed route)'
elif printf '%s' "$route" | grep -q 'proto dhcp'; then
  ok "default route present (DHCP/NAT mode: $(printf '%s' "$route" | head -n1))"
elif [ -n "$host_ip" ] && printf '%s' "$route" | grep -q "via $host_ip"; then
  ok "host-only default route via $host_ip"
else
  adv 'default route present' "unexpected route: $(printf '%s' "$route" | head -n1)"
fi

svc="iptables-rules@${host_ip}.service"
if [ -n "$host_ip" ]; then
  if [ "$(systemctl is-active "$svc" 2>/dev/null)" = 'active' ]; then ok "$svc active"; else bad "$svc active" "is-active=$(systemctl is-active "$svc" 2>/dev/null)"; fi
  if [ "$(systemctl is-enabled "$svc" 2>/dev/null)" = 'enabled' ]; then ok "$svc enabled at boot"; else bad "$svc enabled at boot" "is-enabled=$(systemctl is-enabled "$svc" 2>/dev/null)"; fi
fi

section 'Placeholder credential'

cred="$HOME/.claude/.credentials.json"
if [ ! -f "$cred" ]; then
  bad 'placeholder credential in place' "missing $cred -- copy vm-shared/credentials.json to it"
elif grep -q "$PLACEHOLDER" "$cred"; then
  ok 'credentials.json is the placeholder'
else
  bad 'credentials.json is the placeholder' 'a NON-placeholder token is present in the VM -- a real credential must never live here'
fi

section 'Live egress'

c="$(curl_code 20 http://archive.ubuntu.com/)" && [ "$c" -lt 400 ] 2>/dev/null && ok "allow-listed :80 archive.ubuntu.com -> $c" || bad 'allow-listed :80 archive.ubuntu.com' "code=$c curlExit=$?"

c="$(curl_code 30 https://pypi.org/simple/)" && [ "$c" -lt 400 ] 2>/dev/null && ok "allow-listed passthrough :443 pypi.org -> $c" || bad 'allow-listed passthrough :443 pypi.org' "code=$c curlExit=$?"

if curl -s -o /dev/null --max-time 20 https://blocked.example.com/; then
  bad 'blocked :443 connection dropped' 'curl succeeded; expected a connection failure'
else
  ok "blocked :443 connection dropped (curlExit=$?)"
fi

c="$(curl_code 20 http://blocked.example.com/)"
if [ "$c" = '403' ]; then ok 'blocked :80 -> 403 (default deny)'; else bad 'blocked :80 default deny' "expected 403, got $c"; fi

c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Authorization: Bearer not-the-placeholder' https://api.anthropic.com/)"
if [ "$c" = '403' ]; then ok 'credential gate: wrong Authorization -> 403 (no token spent)'; else bad 'credential gate wrong-auth' "expected 403 from gate.lua, got $c"; fi

printf '\n%d passed, %d failed, %d warnings\n' "$pass" "$fail" "$warn"
[ "$fail" -eq 0 ]
