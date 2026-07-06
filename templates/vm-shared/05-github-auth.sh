#!/usr/bin/env bash
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
config_path="$dir/github-config.txt"

if [ ! -f "$config_path" ]; then
  echo "05-github-auth: $config_path not found. Run 'configamatron write-github-config' on the host first." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$config_path"

if [ -z "${GITHUB_USERNAME:-}" ] || [ -z "${GITHUB_EMAIL:-}" ] || [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "05-github-auth: $config_path is missing GITHUB_USERNAME, GITHUB_EMAIL, or GITHUB_TOKEN" >&2
  exit 1
fi

sudo apt install -y gh

git config --global user.name "$GITHUB_USERNAME"
git config --global user.email "$GITHUB_EMAIL"
echo "$GITHUB_TOKEN" | gh auth login --with-token
gh auth setup-git

echo "05-github-auth: git identity and gh auth configured for $GITHUB_USERNAME <$GITHUB_EMAIL>"
