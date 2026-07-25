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

# Register the context7 MCP server for both agents
# Configure Codex directly because `codex mcp add --url` starts the server's
# optional OAuth flow and blocks unattended provisioning.

claude mcp add --transport http context7 https://mcp.context7.com/mcp

$codexConfigDirectory = Join-Path $HOME '.codex'
$codexConfigPath = Join-Path $codexConfigDirectory 'config.toml'
$context7Section = '[mcp_servers.context7]'
New-Item -ItemType Directory -Force -Path $codexConfigDirectory | Out-Null
if (-not (Test-Path $codexConfigPath) -or -not (Select-String -LiteralPath $codexConfigPath -SimpleMatch $context7Section -Quiet)) {
    Add-Content -LiteralPath $codexConfigPath -Value "`n$context7Section`nurl = `"https://mcp.context7.com/mcp`""
}

Write-Host "04-configure-tools: power timeouts disabled; context7 MCP registered for claude and codex; VS Code Prettier extension installed."
