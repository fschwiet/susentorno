#!/usr/bin/env bash
set -euo pipefail

host_ip="${1:?usage: vm-setup-persistence.sh <host-ip>}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sed "s|@@VM_DIR@@|${script_dir}|g" "${script_dir}/dns-stub.service" > /etc/systemd/system/dns-stub.service
sed "s|@@VM_DIR@@|${script_dir}|g" "${script_dir}/iptables-rules@.service" > "/etc/systemd/system/iptables-rules@.service"

cp "${script_dir}/60-dns-override.yaml" /etc/netplan/60-dns-override.yaml
netplan apply

systemctl daemon-reload
systemctl enable --now dns-stub.service
systemctl enable --now "iptables-rules@${host_ip}.service"

echo "vm-setup-persistence: dns-stub.service and iptables-rules@${host_ip}.service enabled and started; netplan DNS override applied"
