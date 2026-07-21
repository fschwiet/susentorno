#!/usr/bin/env bash
set -euo pipefail

host_ip="${1:?usage: 05-configure-network.sh <host-ip> [cert-path]}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cert_path="${2:-${script_dir}/cert.pem}"

## --- Trust the proxy CA ---

sudo cp "$cert_path" /usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt
sudo update-ca-certificates

# Node.js bundles its own CA list and ignores the system trust store, so tools
# built on it (e.g. the claude CLI) still fail with DEPTH_ZERO_SELF_SIGNED_CERT
# against the sandbox proxy unless NODE_EXTRA_CA_CERTS points at the CA.
echo 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt' | sudo tee /etc/profile.d/node-extra-ca-certs.sh > /dev/null
sudo chmod 644 /etc/profile.d/node-extra-ca-certs.sh

echo "05-configure-network: installed and trusted $cert_path; NODE_EXTRA_CA_CERTS configured for new shells"

# Firefox keeps its own trust store (an NSS cert9.db per profile) and ignores
# both the system CA bundle and NODE_EXTRA_CA_CERTS, so the CA must be registered
# with it separately. An enterprise policy at the standard system-wide location
# does this regardless of how Firefox was installed: apt, snap (Canonical
# special-cased this path), and Mozilla's tarball builds all read
# /etc/firefox/policies/policies.json. Skip gracefully when Firefox is absent.
#
# The cert itself must live in /etc/firefox/policies too: the snap build runs
# strictly confined and its mount namespace shadows /usr/local, so a
# Certificates.Install entry pointing at /usr/local/share/ca-certificates/*
# fails silently. /etc/firefox/policies is the one sanctioned path all builds read.
if command -v firefox > /dev/null 2>&1 || snap list firefox > /dev/null 2>&1; then
  policy_dir=/etc/firefox/policies
  policy_file="${policy_dir}/policies.json"
  ca_for_firefox="${policy_dir}/configamatron-proxy-certificate-authority.pem"
  ca_stale=/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt
  sudo mkdir -p "$policy_dir"
  sudo cp "$cert_path" "$ca_for_firefox"
  sudo chmod 644 "$ca_for_firefox"

  base=$(sudo jq . "$policy_file" 2> /dev/null || echo '{}')
  tmp=$(mktemp)
  printf '%s' "$base" | jq \
    --arg ca "$ca_for_firefox" \
    --arg stale "$ca_stale" \
    '.policies.Certificates.Install = ((.policies.Certificates.Install // []) - [$stale, $ca] + [$ca])' \
    > "$tmp"
  sudo cp "$tmp" "$policy_file"
  rm -f "$tmp"
  sudo chmod 644 "$policy_file"
  echo "05-configure-network: registered CA with Firefox via $policy_file"
else
  echo "05-configure-network: Firefox not found; skipped browser CA registration"
fi

## --- Persistence: dnsmasq + egress + netplan DNS override ---

sudo apt-get install -y dnsmasq

sudo cp "${script_dir}/dnsmasq-stub.conf" /etc/dnsmasq.d/sandbox-stub.conf

sed "s|__HOST_IP__|${host_ip}|g" "${script_dir}/configamatron-egress.service" \
  | sudo tee /etc/systemd/system/configamatron-egress.service > /dev/null

# Discover the primary network interface (physical NIC name, e.g. ens33) so the
# netplan DNS override merges into the active profile. Prefer the default-route
# interface; fall back to the first up, globally-scoped IPv4 interface.
iface="$(ip -o -4 route show default | awk '{print $5}' | head -n1)"
if [[ -z "${iface}" ]]; then
  iface="$(ip -o -4 addr show up scope global | awk '{print $2}' | head -n1)"
fi
if [[ -z "${iface}" ]]; then
  echo "05-configure-network: could not determine the VM's network interface." >&2
  echo "  Bring the VM's network up before running this (NAT or bridged both work)." >&2
  exit 1
fi

sed "s|__IFACE__|${iface}|g" "${script_dir}/60-dns-override.yaml" | sudo tee /etc/netplan/60-dns-override.yaml > /dev/null
sudo chmod 600 /etc/netplan/60-dns-override.yaml
sudo netplan apply

sudo systemctl daemon-reload
sudo systemctl enable --now dnsmasq
sudo systemctl enable configamatron-egress.service
sudo systemctl restart configamatron-egress.service

echo "05-configure-network: dnsmasq and configamatron-egress.service enabled and started; netplan DNS override applied"
