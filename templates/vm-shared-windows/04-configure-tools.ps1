$ErrorActionPreference = 'Stop'

# Never sleep / never blank the display (analog of Ubuntu's screensaver disable).
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0

# Register the context7 MCP server for both agents (mirrors Ubuntu 04).
claude mcp add --transport http context7 https://mcp.context7.com/mcp
codex mcp add context7 --url https://mcp.context7.com/mcp

# VS Code: install Prettier extension and merge user settings (mirrors Ubuntu 04).
code --install-extension esbenp.prettier-vscode

$vscodeUserDir = Join-Path $env:APPDATA 'Code\User'
New-Item -ItemType Directory -Force -Path $vscodeUserDir | Out-Null
$vscodeSettings = Join-Path $vscodeUserDir 'settings.json'

# Merge our required settings into any existing file; start fresh if missing/unparsable
# (mirrors 08-claude-config.ps1's .claude.json merge).
$settingsData = [ordered]@{}
if (Test-Path $vscodeSettings) {
  try { $settingsData = Get-Content $vscodeSettings -Raw | ConvertFrom-Json -AsHashtable } catch { $settingsData = @{} }
}
if ($null -eq $settingsData) { $settingsData = @{} }
$settingsData['files.autoSave'] = 'afterDelay'
$settingsData['editor.formatOnSave'] = $true
$settingsData['editor.defaultFormatter'] = 'esbenp.prettier-vscode'
$settingsData | ConvertTo-Json -Depth 100 | Set-Content -Path $vscodeSettings -Encoding utf8

Write-Host "04-configure-tools: power timeouts disabled; context7 MCP registered for claude and codex; VS Code Prettier extension installed and settings configured."
