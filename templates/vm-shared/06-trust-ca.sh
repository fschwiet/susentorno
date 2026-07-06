#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cert_path="${1:-${script_dir}/cert.pem}"

sudo cp "$cert_path" /usr/local/share/ca-certificates/sbx-sandbox-proxy-ca.crt
sudo update-ca-certificates

echo "06-trust-ca: installed and trusted $cert_path"
