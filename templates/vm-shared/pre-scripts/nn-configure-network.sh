#!/usr/bin/env bash
set -euo pipefail

# <host-ip> is still required, and still validated, even though nothing below reads
# it any more: addressing and DNS now arrive via DHCP. Keeping it means the
# documented invocation and every existing caller stay correct, and a caller that
# has NOT been updated for the host-side design fails loudly here rather than
# silently configuring nothing.
host_ip="${1:?usage: 05-configure-network.sh <host-ip> [cert-path]}"
readonly host_ip
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
share_root="$(dirname "$script_dir")"
cert_path="${2:-${share_root}/cert.pem}"

## --- Trust the proxy CA ---

sudo cp "$cert_path" /usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt
sudo update-ca-certificates

# Node.js bundles its own CA list and ignores the system trust store, so tools
# built on it (e.g. the claude CLI) still fail with DEPTH_ZERO_SELF_SIGNED_CERT
# against the proxy unless NODE_EXTRA_CA_CERTS points at the CA.
echo 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt' | sudo tee /etc/profile.d/node-extra-ca-certs.sh > /dev/null
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
  ca_for_firefox="${policy_dir}/susentorno-proxy-certificate-authority.pem"
  ca_stale=/usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt
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

## --- Networking ---

# Nothing to do. The adapter stays on DHCP for both networks: on the Default Switch
# it leases from Hyper-V's ICS, and on susentorno-internal it leases from
# run-proxy, which supplies the host as both router (option 3) and DNS (option 6).
#
# Deleted along with this section: the dnsmasq stub (names now resolve to the host,
# not a placeholder), the iptables DNAT rules for 80/443 (nothing needs redirecting
# once names already point at the proxy), the guarded default-route install (the
# route arrives via DHCP), and the netplan DNS override with its DHCP-DNS
# suppression (only one resolver is ever present now).

echo "05-configure-network: CA trusted; addressing and DNS come from the host via DHCP"
