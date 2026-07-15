#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.claude"

# The claude CLI refuses to run until ~/.claude.json records that onboarding
# completed. Merge the single flag into any existing file with jq rather than
# clobbering it, starting fresh only if the file is missing or unparsable. Write
# to a temp file and move it into place so a failure never truncates the target.
claude_json="$HOME/.claude.json"
base=$(jq . "$claude_json" 2> /dev/null || echo '{}')
tmp=$(mktemp)
printf '%s' "$base" | jq '.hasCompletedOnboarding = true' > "$tmp"
mv "$tmp" "$claude_json"

# Symlink the placeholder credential into place instead of copying it, so it
# tracks the shared credentials.json (regenerated whenever the environment is
# re-initialized) rather than snapshotting it. -f replaces any prior file or
# symlink, so re-running is safe. The target lives on the read-only share; the
# placeholder never expires (expiresAt is year 2100), so the CLI never tries to
# rewrite it.
ln -sfn "${script_dir}/credentials.json" "$HOME/.claude/.credentials.json"

echo "08-claude-config: set hasCompletedOnboarding in ${claude_json}; linked ~/.claude/.credentials.json -> ${script_dir}/credentials.json"
