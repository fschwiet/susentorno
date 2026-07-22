$ErrorActionPreference = 'Stop'

# Never sleep / never blank the display (analog of Ubuntu's screensaver disable).
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0

# VS Code extensions

code --install-extension esbenp.prettier-vscode
code --install-extension csharpier.csharpier-vscode
code --install-extension JakubKozera.csharp-dev-tools

# VS Code settings are applied later by 07-apply-home-jq-transforms.ps1 from
# home-jq-transforms/, so users can customize them.

# codebase-memory-mcp
# - install is idempotent, must install after coding agents for it to be configured

$codebaseMemoryInstaller = Join-Path $env:TEMP 'codebase-memory-mcp-install.ps1'
Invoke-WebRequest -Uri https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile $codebaseMemoryInstaller
Unblock-File $codebaseMemoryInstaller
& $codebaseMemoryInstaller
Remove-Item $codebaseMemoryInstaller

# Register the context7 MCP server for both agents (mirrors Ubuntu 04).
## Call codex last because it blocks on login request we aren't going to respond to.

claude mcp add --transport http context7 https://mcp.context7.com/mcp
codex mcp add context7 --url https://mcp.context7.com/mcp

Write-Host "04-configure-tools: power timeouts disabled; context7 MCP registered for claude and codex; VS Code Prettier extension installed."
