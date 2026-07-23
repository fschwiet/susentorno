#!/usr/bin/env bash
set -euo pipefail

host_ip="\${1:?usage: 05-configure-network.sh <host-ip> [cert-path]}"
script_dir="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
share_root="\$(dirname "\${script_dir}")"
cert_path="\${2:-\${share_root}/cert.pem}"

sudo cp "\${cert_path}" /usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt
sudo update-ca-certificates
echo 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt' |
  sudo tee /etc/profile.d/node-extra-ca-certs.sh > /dev/null
sudo chmod 644 /etc/profile.d/node-extra-ca-certs.sh

## --- Networking ---
# The adapter remains on DHCP for both networks. Hyper-V ICS serves the Default
# Switch; run-proxy serves configamatron-internal with the host as router and DNS.
echo "05-configure-network: CA trusted; addressing and DNS come from the host via DHCP"
