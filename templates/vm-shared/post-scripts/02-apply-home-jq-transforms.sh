#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
share_root="$(dirname "$script_dir")"

node "$script_dir/apply-home-jq-transforms.mjs" "$share_root/home-jq-transforms"
