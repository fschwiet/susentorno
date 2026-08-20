$ErrorActionPreference = 'Stop'

# Node runtime managed by pnpm (mirrors Ubuntu 03-install-tools.sh).
pnpm runtime set node latest -g

# Pi Coding Agent
pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent

# Claude Code CLI — native Windows installer.
winget install Anthropic.ClaudeCode

# Codex CLI — cross-platform npm package via pnpm.
pnpm add -g @openai/codex

Write-Host "03-install-tools: node runtime, pi-coding-agent, claude, and codex installed. Open a new terminal so PATH updates apply."
