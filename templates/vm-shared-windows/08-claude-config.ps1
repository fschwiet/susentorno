$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$claudeDir = Join-Path $env:USERPROFILE '.claude'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

# The claude CLI refuses to run until ~/.claude.json records onboarding completed.
# Merge the single flag into any existing file with jq; start fresh if missing or
# unparsable. Write to a temp file and move it into place so a failure never
# truncates the target.
$claudeJson = Join-Path $env:USERPROFILE '.claude.json'
$base = jq . $claudeJson 2>$null
if ($LASTEXITCODE -ne 0) { $base = '{}' }
$tmp = [System.IO.Path]::GetTempFileName()
$base | jq '.hasCompletedOnboarding = true' | Set-Content -Path $tmp -Encoding utf8
Move-Item -Force $tmp $claudeJson

# Copy the placeholder credential into place. A plain copy (not a symlink, which
# needs admin/Developer Mode) is safe: the placeholder never expires, so the CLI
# never rewrites it. Re-running after `init` regenerates the file re-copies it.
$src = Join-Path $scriptDir 'credentials.json'
Copy-Item -Force $src (Join-Path $claudeDir '.credentials.json')

Write-Host "08-claude-config: set hasCompletedOnboarding in $claudeJson; copied placeholder credential into $claudeDir"
