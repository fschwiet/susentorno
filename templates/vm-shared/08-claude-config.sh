#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.claude"

# The claude CLI refuses to run until ~/.claude.json records that onboarding
# completed. Merge the single flag into any existing file rather than clobbering
# it (starting fresh only if the file is unparsable), mirroring 06-trust-ca.sh.
# python3 is part of the Ubuntu base system, so this adds no package dependency.
claude_json="$HOME/.claude.json"
python3 - "$claude_json" <<'PY'
import json, os, sys

path = sys.argv[1]
data = {}
if os.path.exists(path):
    with open(path) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            data = {}  # unparsable file: start fresh rather than fail provisioning

data["hasCompletedOnboarding"] = True

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

# Symlink the placeholder credential into place instead of copying it, so it
# tracks the shared credentials.json (regenerated whenever the environment is
# re-initialized) rather than snapshotting it. -f replaces any prior file or
# symlink, so re-running is safe. The target lives on the read-only share; the
# placeholder never expires (expiresAt is year 2100), so the CLI never tries to
# rewrite it.
ln -sfn "${script_dir}/credentials.json" "$HOME/.claude/.credentials.json"

echo "08-claude-config: set hasCompletedOnboarding in ${claude_json}; linked ~/.claude/.credentials.json -> ${script_dir}/credentials.json"
