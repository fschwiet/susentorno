#!/usr/bin/env bash
set -euo pipefail

## Screen Locking

# Disable the automatic screen lock mechanism
gsettings set org.gnome.desktop.screensaver lock-enabled false

# Set the screen blanking inactivity timeout to "Never" (0)
gsettings set org.gnome.desktop.session idle-delay 0

# VS Code extensions

code --install-extension esbenp.prettier-vscode
code --install-extension csharpier.csharpier-vscode
code --install-extension JakubKozera.csharp-dev-tools

# VS Code configuration

vscode_settings_dir="$HOME/.config/Code/User"
mkdir -p "$vscode_settings_dir"
vscode_settings="$vscode_settings_dir/settings.json"

# Merge our required settings into any existing file with jq rather than
# clobbering it, starting fresh only if the file is missing or unparsable. Write
# to a temp file and move it into place so a failure never truncates the target.
base=$(jq . "$vscode_settings" 2> /dev/null || echo '{}')
tmp=$(mktemp)
printf '%s' "$base" | jq '
  .["files.autoSave"] = "afterDelay"
  | .["editor.formatOnSave"] = true
  | .["editor.defaultFormatter"] = "esbenp.prettier-vscode"
  | .["[csharp]"] = {"editor.defaultFormatter": "csharpier.csharpier-vscode"}
' > "$tmp"
mv "$tmp" "$vscode_settings"

# codebase-memory-mcp
# - install is idempotent, must install after coding agents for it to be configured

curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash

## Agent configurations
## Call codex last because it blocks on login request we aren't going to respond to.

claude mcp add --transport http context7 https://mcp.context7.com/mcp
codex mcp add context7 --url https://mcp.context7.com/mcp
