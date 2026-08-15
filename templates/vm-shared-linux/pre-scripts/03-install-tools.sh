#!/usr/bin/env bash
set -euo pipefail

# Pi Coding Agent
pnpm runtime set node latest -g

curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh

curl -fsSL https://claude.ai/install.sh | bash

pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent

echo "03-install-tools: node runtime, codex, claude, and the Pi coding agent installed."
