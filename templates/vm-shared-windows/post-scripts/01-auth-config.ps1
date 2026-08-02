$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$shareRoot = Split-Path -Parent $scriptDir

# --- GitHub auth (GitHub.cli is installed in 01-install-packages.ps1) ---

$configPath = Join-Path $shareRoot 'github-config.txt'
if (-not (Test-Path $configPath)) {
  Write-Error "01-auth-config: $configPath not found. Run 'susentorno write-github-config' on the host first."
  exit 1
}

# github-config.txt is shell-style KEY="value" lines. Strip the surrounding quotes.
$cfg = @{}
foreach ($line in Get-Content $configPath) {
  if ($line -match '^\s*([A-Z_]+)=(.*)$') { $cfg[$matches[1]] = $matches[2].Trim('"') }
}
foreach ($k in 'GITHUB_USERNAME', 'GITHUB_EMAIL', 'GITHUB_TOKEN') {
  if (-not $cfg.ContainsKey($k) -or [string]::IsNullOrEmpty($cfg[$k])) {
    Write-Error "01-auth-config: $configPath is missing $k"; exit 1
  }
}

git config --global user.name  $cfg['GITHUB_USERNAME']
git config --global user.email $cfg['GITHUB_EMAIL']
$cfg['GITHUB_TOKEN'] | gh auth login --with-token
if ($LASTEXITCODE -ne 0) { Write-Error "01-auth-config: gh auth login failed"; exit 1 }
gh auth setup-git
if ($LASTEXITCODE -ne 0) { Write-Error "01-auth-config: gh auth setup-git failed"; exit 1 }

# --- Claude placeholder credential (onboarding flag is applied in step 07) ---

$claudeDir = Join-Path $env:USERPROFILE '.claude'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
Copy-Item -Force (Join-Path $shareRoot 'credentials.json') (Join-Path $claudeDir '.credentials.json')

# --- Codex placeholder credential ---

$codexDir = Join-Path $env:USERPROFILE '.codex'
New-Item -ItemType Directory -Force -Path $codexDir | Out-Null
Copy-Item -Force (Join-Path $shareRoot 'auth.json') (Join-Path $codexDir 'auth.json')

Write-Host "01-auth-config: gh auth configured for $($cfg['GITHUB_USERNAME']) <$($cfg['GITHUB_EMAIL'])>; placeholder claude + codex credentials installed"
