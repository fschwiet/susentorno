#!/usr/bin/env bash
set -euo pipefail

host_ip="${1:?usage: 07-setup-persistence.sh <host-ip>}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

apt-get install -y dnsmasq

cp "${script_dir}/dnsmasq-stub.conf" /etc/dnsmasq.d/sandbox-stub.conf

cp "${script_dir}/iptables-rules@.service" /etc/systemd/system/iptables-rules@.service

# Discover the primary network interface. The netplan DNS override must bind to
# the same ethernet id the installer used (the physical NIC name, e.g. ens33) so
# netplan merges into the active profile rather than creating a competing one.
# Prefer the default-route interface; fall back to the first up, globally-scoped
# IPv4 interface so discovery still works when the VM has no default route (e.g.
# host-only networking, where VMware's DHCP hands out no gateway). Both methods
# yield the same NIC name.
iface="$(ip -o -4 route show default | awk '{print $5}' | head -n1)"
if [[ -z "${iface}" ]]; then
  iface="$(ip -o -4 addr show up scope global | awk '{print $2}' | head -n1)"
fi
if [[ -z "${iface}" ]]; then
  echo "07-setup-persistence: could not determine the VM's network interface." >&2
  echo "  Found no default IPv4 route and no up, globally-scoped IPv4 interface." >&2
  echo "  Bring the VM's network up before running this (NAT or bridged both work;" >&2
  echo "  host-only has no default route but should still expose an IPv4 interface)." >&2
  exit 1
fi

sed "s|__IFACE__|${iface}|g" "${script_dir}/60-dns-override.yaml" > /etc/netplan/60-dns-override.yaml
chmod 600 /etc/netplan/60-dns-override.yaml
netplan apply

systemctl daemon-reload
systemctl enable --now dnsmasq
systemctl enable --now "iptables-rules@${host_ip}.service"

echo "07-setup-persistence: dnsmasq and iptables-rules@${host_ip}.service enabled and started; netplan DNS override applied"
