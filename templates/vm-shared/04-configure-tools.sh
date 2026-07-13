#!/usr/bin/env bash
set -euo pipefail

## Screen Locking

# Disable the automatic screen lock mechanism
gsettings set org.gnome.desktop.screensaver lock-enabled false

# Set the screen blanking inactivity timeout to "Never" (0)
gsettings set org.gnome.desktop.session idle-delay 0

## Agent configurations

claude mcp add --transport http context7 https://mcp.context7.com/mcp
codex mcp add context7 --url https://mcp.context7.com/mcp
codex mcp add context7 --command "npx" --args "-y,@upstash/context7-mcp"
