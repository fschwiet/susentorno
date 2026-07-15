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

# VS Code configuration

$vscodeUserDir = Join-Path $env:APPDATA 'Code\User'
New-Item -ItemType Directory -Force -Path $vscodeUserDir | Out-Null
$vscodeSettings = Join-Path $vscodeUserDir 'settings.json'

# Merge our required settings into any existing file with jq; start fresh if
# missing or unparsable. Seed a `{}` file when missing so jq always reads a real
# file: under `$ErrorActionPreference = 'Stop'`, Windows PowerShell 5.1 turns
# jq's "could not open file" stderr into a terminating error, killing the script
# before the exit-code check. Write to a temp file and move it into place so a
# failure never truncates the target.
if (-not (Test-Path -LiteralPath $vscodeSettings)) { Set-Content -Path $vscodeSettings -Value '{}' -Encoding utf8 }
$base = jq . $vscodeSettings 2>$null
if ($LASTEXITCODE -ne 0) { $base = '{}' }
$tmp = [System.IO.Path]::GetTempFileName()
$base | jq '.["files.autoSave"]="afterDelay" | .["editor.formatOnSave"]=true | .["editor.defaultFormatter"]="esbenp.prettier-vscode" | .["[csharp]"]={"editor.defaultFormatter":"csharpier.csharpier-vscode"}' | Set-Content -Path $tmp -Encoding utf8
Move-Item -Force $tmp $vscodeSettings


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

Write-Host "04-configure-tools: power timeouts disabled; context7 MCP registered for claude and codex; VS Code Prettier extension installed and settings configured."
