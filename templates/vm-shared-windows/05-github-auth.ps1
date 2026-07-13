$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir 'github-config.txt'

if (-not (Test-Path $configPath)) {
  Write-Error "05-github-auth: $configPath not found. Run 'configamatron write-github-config' on the host first."
  exit 1
}

# github-config.txt is shell-style KEY="value" lines. Strip the surrounding quotes.
$cfg = @{}
foreach ($line in Get-Content $configPath) {
  if ($line -match '^\s*([A-Z_]+)=(.*)$') { $cfg[$matches[1]] = $matches[2].Trim('"') }
}
foreach ($k in 'GITHUB_USERNAME', 'GITHUB_EMAIL', 'GITHUB_TOKEN') {
  if (-not $cfg.ContainsKey($k) -or [string]::IsNullOrEmpty($cfg[$k])) {
    Write-Error "05-github-auth: $configPath is missing $k"; exit 1
  }
}

git config --global user.name  $cfg['GITHUB_USERNAME']
git config --global user.email $cfg['GITHUB_EMAIL']
$cfg['GITHUB_TOKEN'] | gh auth login --with-token
gh auth setup-git

Write-Host "05-github-auth: git identity and gh auth configured for $($cfg['GITHUB_USERNAME']) <$($cfg['GITHUB_EMAIL'])>"
