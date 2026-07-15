#!/usr/bin/env bash
set -euo pipefail

## Screen Locking

# Disable the automatic screen lock mechanism
gsettings set org.gnome.desktop.screensaver lock-enabled false

# Set the screen blanking inactivity timeout to "Never" (0)
gsettings set org.gnome.desktop.session idle-delay 0

## VS Code

code --install-extension esbenp.prettier-vscode
code --install-extension csharpier.csharpier-vscode

vscode_settings_dir="$HOME/.config/Code/User"
mkdir -p "$vscode_settings_dir"
vscode_settings="$vscode_settings_dir/settings.json"

# Merge our required settings into any existing file rather than clobbering it
# (starting fresh only if the file is unparsable), mirroring 06-trust-ca.sh /
# 08-claude-config.sh. python3 is part of the Ubuntu base system.
python3 - "$vscode_settings" <<'PY'
import json, os, sys

path = sys.argv[1]
data = {}
if os.path.exists(path):
    with open(path) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            data = {}  # unparsable file: start fresh rather than fail provisioning

data["files.autoSave"] = "afterDelay"
data["editor.formatOnSave"] = True
data["editor.defaultFormatter"] = "esbenp.prettier-vscode"
data["[csharp]"] = {"editor.defaultFormatter": "csharpier.csharpier-vscode"}

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

# codebase-memory-mcp install is idempotent, must install after coding agents
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash

## Agent configurations
## Call codex last because it blocks on login request we aren't going to respond to.

claude mcp add --transport http context7 https://mcp.context7.com/mcp
codex mcp add context7 --url https://mcp.context7.com/mcp
