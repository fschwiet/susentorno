$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$claudeDir = Join-Path $env:USERPROFILE '.claude'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

# The claude CLI refuses to run until ~/.claude.json records onboarding completed.
# Merge the single flag into any existing file; start fresh if missing/unparsable.
$claudeJson = Join-Path $env:USERPROFILE '.claude.json'
$data = [ordered]@{}
if (Test-Path $claudeJson) {
  try { $data = Get-Content $claudeJson -Raw | ConvertFrom-Json -AsHashtable } catch { $data = @{} }
}
if ($null -eq $data) { $data = @{} }
$data['hasCompletedOnboarding'] = $true
$data | ConvertTo-Json -Depth 100 | Set-Content -Path $claudeJson -Encoding utf8

# Copy the placeholder credential into place. A plain copy (not a symlink, which
# needs admin/Developer Mode) is safe: the placeholder never expires, so the CLI
# never rewrites it. Re-running after `init` regenerates the file re-copies it.
$src = Join-Path $scriptDir 'credentials.json'
Copy-Item -Force $src (Join-Path $claudeDir '.credentials.json')

Write-Host "08-claude-config: set hasCompletedOnboarding in $claudeJson; copied placeholder credential into $claudeDir"
