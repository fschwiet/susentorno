#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$(dirname "$script_dir")"

## --- GitHub auth (gh is installed in 01-apt-packages.sh, pre-isolation) ---

config_path="$dir/github-config.txt"
if [ ! -f "$config_path" ]; then
  echo "06-auth-config: $config_path not found. Run 'susentorno write-github-config' on the host first." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$config_path"

if [ -z "${GITHUB_USERNAME:-}" ] || [ -z "${GITHUB_EMAIL:-}" ] || [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "06-auth-config: $config_path is missing GITHUB_USERNAME, GITHUB_EMAIL, or GITHUB_TOKEN" >&2
  exit 1
fi

git config --global user.name "$GITHUB_USERNAME"
git config --global user.email "$GITHUB_EMAIL"
echo "$GITHUB_TOKEN" | gh auth login --with-token
gh auth setup-git

## --- Claude placeholder credential (onboarding flag is applied in step 07) ---

mkdir -p "$HOME/.claude"
# Symlink so it tracks the shared placeholder (regenerated on re-init). The
# placeholder never expires, so the CLI never rewrites it.
ln -sfn "${dir}/credentials.json" "$HOME/.claude/.credentials.json"

## --- Codex placeholder credential ---

mkdir -p "$HOME/.codex"
ln -sfn "${dir}/auth.json" "$HOME/.codex/auth.json"

echo "06-auth-config: git identity + gh auth configured for $GITHUB_USERNAME <$GITHUB_EMAIL>; linked placeholder claude + codex credentials"
