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
ca_installed=/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt
if command -v firefox > /dev/null 2>&1 || snap list firefox > /dev/null 2>&1; then
  policy_dir=/etc/firefox/policies
  policy_file="${policy_dir}/policies.json"
  sudo mkdir -p "$policy_dir"

  # Merge our CA into any existing policy rather than clobbering it. python3 is
  # part of the Ubuntu base system, so this adds no package dependency.
  sudo python3 - "$policy_file" "$ca_installed" <<'PY'
import json, os, sys

policy_file, ca = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(policy_file):
    with open(policy_file) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            data = {}  # unparsable file: start fresh rather than fail provisioning

certs = data.setdefault("policies", {}).setdefault("Certificates", {})
installs = certs.setdefault("Install", [])
if ca not in installs:
    installs.append(ca)

with open(policy_file, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
  sudo chmod 644 "$policy_file"
  echo "06-trust-ca: registered CA with Firefox via $policy_file"
else
  echo "06-trust-ca: Firefox not found; skipped browser CA registration"
fi
