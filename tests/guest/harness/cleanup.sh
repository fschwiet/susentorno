#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Kill everything the harness may have left behind: socat forwarders live in
# transient systemd units, guests and dnsmasq behind pidfiles.
systemctl stop cfgm-fwd-80.service cfgm-fwd-443.service 2> /dev/null || true

for pidfile in "$RUN"/*.pid; do
  [ -f "$pidfile" ] || continue
  kill "$(cat "$pidfile")" 2> /dev/null || true
  rm -f "$pidfile"
done

for tap in $(ip -o link show | awk -F': ' '{print $2}' | grep '^tap-' || true); do
  ip link del "${tap%%@*}" 2> /dev/null || true
done

iptables -t nat -D POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE 2> /dev/null || true
ip link del "$BRIDGE" 2> /dev/null || true
echo "cleanup: done"
