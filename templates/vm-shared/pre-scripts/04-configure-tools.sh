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

# VS Code settings (files.autoSave, formatter, etc.) are applied later by
# 07-apply-home-jq-transforms.sh from home-jq-transforms/, so users can customize them.

# codebase-memory-mcp
# - install is idempotent, must install after coding agents for it to be configured

curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash

## Agent configurations
## Call codex last because it blocks on login request we aren't going to respond to.

claude mcp add --transport http context7 https://mcp.context7.com/mcp
codex mcp add context7 --url https://mcp.context7.com/mcp
