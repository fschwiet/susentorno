#!/usr/bin/env bash
set -euo pipefail

host_ip="${1:?usage: vm-setup-persistence.sh <host-ip>}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

apt-get install -y dnsmasq

cp "${script_dir}/dnsmasq-stub.conf" /etc/dnsmasq.d/sandbox-stub.conf

cp "${script_dir}/iptables-rules@.service" /etc/systemd/system/iptables-rules@.service

iface="$(ip -o -4 route show default | awk '{print $5}' | head -n1)"
sed "s|__IFACE__|${iface}|g" "${script_dir}/60-dns-override.yaml" > /etc/netplan/60-dns-override.yaml
chmod 600 /etc/netplan/60-dns-override.yaml
netplan apply

systemctl daemon-reload
systemctl enable --now dnsmasq
systemctl enable --now "iptables-rules@${host_ip}.service"

echo "vm-setup-persistence: dnsmasq and iptables-rules@${host_ip}.service enabled and started; netplan DNS override applied"
