$ErrorActionPreference = 'Stop'

# Node runtime managed by pnpm (mirrors Ubuntu 03-install-tools.sh).
pnpm runtime set node latest -g

# Pi Coding Agent
pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent

# Claude Code CLI — native Windows installer.
winget install Anthropic.ClaudeCode

# Codex CLI — cross-platform npm package via pnpm.
pnpm add -g @openai/codex

# dotnet tools
## dotnet tool install --global was confirmed to be idempotent

dotnet tool install --global dotnet-outdated-tool
dotnet tool install --global csharpier

Write-Host "03-install-tools: node, claude, codex, and VS Code installed. Open a new terminal so PATH updates apply."
