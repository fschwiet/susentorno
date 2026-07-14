#!/usr/bin/env bash
set -euo pipefail

pnpm runtime set node latest -g

curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh

curl -fsSL https://claude.ai/install.sh | bash

sudo snap install code --classic

## dotnet tools

cat << \EOF >> ~/.bashrc
# Add .NET Core SDK tools
export PATH="$PATH:/home/username/.dotnet/tools"
EOF

dotnet tool install --global dotnet-outdated-tool
dotnet tool install --global csharpier

echo "03-install-tools: node runtime, codex, claude, and VS Code installed. Open a new terminal before running vm/04-claude-mcp.sh, so claude is on PATH."
