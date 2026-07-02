#!/usr/bin/env bash
set -euo pipefail

export MSYS2_ARG_CONV_EXCL="/CN="

out_dir="$(cd "$(dirname "$0")/.." && pwd)/envoy/ca"
mkdir -p "$out_dir"

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$out_dir/key.pem" \
  -out "$out_dir/cert.pem" \
  -subj "/CN=sbx-sandbox-proxy-ca" \
  -addext "subjectAltName=DNS:api.anthropic.com,DNS:claude.com,DNS:platform.claude.com,DNS:statsig.anthropic.com,DNS:mcp-proxy.anthropic.com,DNS:downloads.claude.ai"

cp "$out_dir/cert.pem" vm

echo "Generated CA cert/key in $out_dir"
