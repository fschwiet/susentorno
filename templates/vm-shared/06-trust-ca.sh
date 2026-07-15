#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cert_path="${1:-${script_dir}/cert.pem}"

sudo cp "$cert_path" /usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt
sudo update-ca-certificates

# Node.js bundles its own CA list and ignores the system trust store, so tools
# built on it (e.g. the claude CLI) still fail with DEPTH_ZERO_SELF_SIGNED_CERT
# against the sandbox proxy unless NODE_EXTRA_CA_CERTS points at the CA.
echo 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt' | sudo tee /etc/profile.d/node-extra-ca-certs.sh > /dev/null
sudo chmod 644 /etc/profile.d/node-extra-ca-certs.sh

echo "06-trust-ca: installed and trusted $cert_path; NODE_EXTRA_CA_CERTS configured for new shells"

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
# fails silently (policy shows Active in about:policies, import never happens,
# terminated hosts die with SEC_ERROR_UNKNOWN_ISSUER). /etc/firefox/policies is
# the one sanctioned path all builds can read — verified from inside the snap
# sandbox with `snap run --shell firefox`.
if command -v firefox > /dev/null 2>&1 || snap list firefox > /dev/null 2>&1; then
  policy_dir=/etc/firefox/policies
  policy_file="${policy_dir}/policies.json"
  ca_for_firefox="${policy_dir}/configamatron-proxy-certificate-authority.pem"
  ca_stale=/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt
  sudo mkdir -p "$policy_dir"
  sudo cp "$cert_path" "$ca_for_firefox"
  sudo chmod 644 "$ca_for_firefox"

  # Merge our CA into any existing policy with jq rather than clobbering it, and
  # drop the snap-unreadable /usr/local path earlier revisions of this script
  # wrote. The policy file is root-owned, so read and write it under sudo; jq's
  # merge itself runs as the normal user (it only reads stdin). Removing then
  # re-appending the CA keeps it present exactly once and makes the update
  # idempotent. Start fresh only if the file is missing or unparsable.
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
  echo "06-trust-ca: registered CA with Firefox via $policy_file"
else
  echo "06-trust-ca: Firefox not found; skipped browser CA registration"
fi
