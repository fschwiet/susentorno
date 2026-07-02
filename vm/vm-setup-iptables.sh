#!/usr/bin/env bash
set -euo pipefail

host_ip="${1:?usage: vm-setup-iptables.sh <host-ip>}"

iptables -t nat -A OUTPUT -p tcp --dport 443 -j DNAT --to-destination "${host_ip}:443"
iptables -t nat -A OUTPUT -p tcp --dport 80 -j DNAT --to-destination "${host_ip}:80"

echo "vm-setup-iptables: DNAT rules installed, routing tcp/443 and tcp/80 to ${host_ip}"
