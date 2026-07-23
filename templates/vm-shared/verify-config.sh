#!/usr/bin/env bash
set -uo pipefail
host_ip="\${1:?usage: verify-config.sh <host-ip>}"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "PASS: \$1"; }
bad() { fail=$((fail+1)); echo "FAIL: \$1"; }
resolved="\$(getent hosts example.com 2>/dev/null | awk '{print \$1}' | head -n1)"
if [ "\$resolved" = "\$host_ip" ]; then ok "names resolve to the host (\$resolved)"; else bad "names resolve to the host"; fi
if ! sudo iptables -t nat -S OUTPUT 2>/dev/null | grep -q DNAT; then ok "no DNAT rules (traffic goes straight to the proxy)"; else bad "no DNAT rules"; fi
if ! systemctl is-active --quiet dnsmasq 2>/dev/null; then ok "no in-guest dnsmasq (DNS is served by the host)"; else bad "no in-guest dnsmasq"; fi
if ip -4 route show default | grep -q "default via \$host_ip"; then ok "default route uses the host"; else bad "default route uses the host"; fi
echo "\$pass passed, \$fail failed"
[ "\$fail" -eq 0 ]
