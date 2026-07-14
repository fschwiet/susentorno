$ErrorActionPreference = 'Stop'

# Node runtime managed by pnpm (mirrors Ubuntu 03-install-tools.sh).
pnpm runtime set node latest -g

# Claude Code CLI — native Windows installer.
Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression

# Codex CLI — cross-platform npm package via pnpm.
pnpm add -g @openai/codex

# VS Code — winget (mirrors 01-install-packages.ps1's winget usage).
winget install --id Microsoft.VisualStudioCode --exact --silent --accept-source-agreements --accept-package-agreements

Write-Host "03-install-tools: node, claude, codex, and VS Code installed. Open a new terminal so PATH updates apply."
