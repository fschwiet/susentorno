#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.codex"

# Symlink the placeholder credential into place instead of copying it, so it tracks
# the shared auth.json (regenerated whenever the environment is re-initialized)
# rather than snapshotting it. -f replaces any prior file or symlink, so re-running
# is safe. The target lives on the read-only share; the placeholder's access-token
# JWT never expires (exp is year 2100), so Codex never tries to rewrite it.
ln -sfn "${script_dir}/auth.json" "$HOME/.codex/auth.json"

echo "09-codex-config: linked ~/.codex/auth.json -> ${script_dir}/auth.json"
