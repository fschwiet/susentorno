$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$codexDir = Join-Path $env:USERPROFILE '.codex'
New-Item -ItemType Directory -Force -Path $codexDir | Out-Null

# Copy the placeholder credential into place. A plain copy (not a symlink, which needs
# admin/Developer Mode) is safe: the placeholder's access-token JWT never expires, so
# Codex never rewrites it. Re-running after `init` regenerates the file re-copies it.
$src = Join-Path $scriptDir 'auth.json'
Copy-Item -Force $src (Join-Path $codexDir 'auth.json')

Write-Host "09-codex-config: copied placeholder auth.json into $codexDir"
