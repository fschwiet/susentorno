$ErrorActionPreference = 'Stop'

# Node runtime managed by pnpm (mirrors Ubuntu 03-install-tools.sh).
pnpm runtime set node latest -g

# Claude Code CLI — native Windows installer.
Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression

# Codex CLI — cross-platform npm package via pnpm.
pnpm add -g @openai/codex

# dotnet tools
## dotnet tool install --global was confirmed to be idempotent

dotnet tool install --global dotnet-outdated-tool
dotnet tool install --global csharpier

Write-Host "03-install-tools: node, claude, codex, and VS Code installed. Open a new terminal so PATH updates apply."
