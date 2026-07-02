#!/usr/bin/env bash
set -euo pipefail

credentials_path="${HOME}/.claude/credentials.json"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
secret_path="${repo_root}/envoy/secrets/sds-secret.yaml"

if [ ! -f "$credentials_path" ]; then
  echo "host-session-hook: $credentials_path not found, skipping" >&2
  exit 0
fi

access_token="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).claudeAiOauth.accessToken)" "$credentials_path")"

mkdir -p "$(dirname "$secret_path")"
cat > "$secret_path" <<EOF
resources:
  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret
    name: sandbox_bearer_token
    generic_secret:
      secret:
        inline_string: "Bearer ${access_token}"
EOF

echo "host-session-hook: synced Claude credential into $secret_path"
