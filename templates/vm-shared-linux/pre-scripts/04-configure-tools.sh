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
code --install-extension 1YiB.svelte-bundle

# VS Code settings (files.autoSave, formatter, etc.) are applied later by
# 07-apply-home-jq-transforms.sh from home-jq-transforms/, so users can customize them.

# codebase-memory-mcp
# - install is idempotent, must install after coding agents for it to be configured

curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash

## Agent configurations
# Configure Codex directly because `codex mcp add --url` starts the server's
# optional OAuth flow and blocks unattended provisioning.

if ! claude mcp get context7 >/dev/null 2>&1; then
    claude mcp add --transport http context7 https://mcp.context7.com/mcp
fi

codex_config_directory="$HOME/.codex"
codex_config_path="$codex_config_directory/config.toml"
mkdir -p "$codex_config_directory"
if [[ ! -f "$codex_config_path" ]] || ! grep -Fqx '[mcp_servers.context7]' "$codex_config_path"; then
    printf '\n[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n' >> "$codex_config_path"
fi
