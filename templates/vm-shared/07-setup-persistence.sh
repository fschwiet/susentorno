#!/usr/bin/env bash
set -euo pipefail

# Safe to re-run: every step is an idempotent overwrite or a no-op. The egress
# unit has a fixed filename (configamatron-egress.service), so a rerun rewrites
# that one file and restarts one unit -- re-running with a different host IP
# never leaves a second unit behind. (A live IP change leaves the old DNAT rules
# in the table until the next reboot, which clears them.)

host_ip="${1:?usage: 07-setup-persistence.sh <host-ip>}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sudo apt-get install -y dnsmasq

sudo cp "${script_dir}/dnsmasq-stub.conf" /etc/dnsmasq.d/sandbox-stub.conf

sed "s|__HOST_IP__|${host_ip}|g" "${script_dir}/configamatron-egress.service" \
  | sudo tee /etc/systemd/system/configamatron-egress.service > /dev/null

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

sed "s|__IFACE__|${iface}|g" "${script_dir}/60-dns-override.yaml" | sudo tee /etc/netplan/60-dns-override.yaml > /dev/null
sudo chmod 600 /etc/netplan/60-dns-override.yaml
sudo netplan apply

sudo systemctl daemon-reload
sudo systemctl enable --now dnsmasq
sudo systemctl enable configamatron-egress.service
sudo systemctl restart configamatron-egress.service

echo "07-setup-persistence: dnsmasq and configamatron-egress.service enabled and started; netplan DNS override applied"
