#!/usr/bin/env bash
set -euo pipefail

pnpm runtime set node latest -g

curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh

curl -fsSL https://claude.ai/install.sh | bash

sudo snap install code --classic

echo "03-install-tools: node runtime, codex, claude, and VS Code installed. Open a new terminal before running vm/04-claude-mcp.sh, so claude is on PATH."
