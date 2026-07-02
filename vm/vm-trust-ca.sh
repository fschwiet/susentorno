#!/usr/bin/env bash
set -euo pipefail

cert_path="${1:?usage: vm-trust-ca.sh <path-to-cert.pem>}"

cp "$cert_path" /usr/local/share/ca-certificates/sbx-sandbox-proxy-ca.crt
update-ca-certificates

echo "vm-trust-ca: installed and trusted $cert_path"
