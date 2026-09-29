$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Post-isolation, in a fresh elevated Windows PowerShell 5.1 process, reading from the
# read-only UNC phase directory. Every input is validated before any guest state changes,
# and every replay refreshes Git identity, GitHub auth, and both placeholder credentials.
# The GitHub token is only ever piped to gh on stdin; it is never printed or embedded in
# an error.

function Fail([string]$Message) { throw "01-auth-config: $Message" }

$shareRoot = Split-Path -Parent $PSScriptRoot

# --- Validate everything before changing anything ---

foreach ($tool in 'git', 'gh') {
  $command = Get-Command $tool -ErrorAction SilentlyContinue
  if (-not $command) { Fail "$tool did not resolve on PATH; 01-install-packages.ps1 must run first" }
  $null = & $command.Source --version
  $status = $LASTEXITCODE
  if ($status -ne 0) { Fail "$tool --version exited $status" }
}

$configPath = Join-Path $shareRoot 'github-config.txt'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  Fail "$configPath not found. Run 'susentorno write-github-config' on the host first."
}

# github-config.txt is shell-style KEY="value" lines. Strip the surrounding quotes.
$cfg = @{}
foreach ($line in [System.IO.File]::ReadAllLines($configPath)) {
  if ($line -match '^\s*([A-Z_]+)=(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') }
}
foreach ($k in 'GITHUB_USERNAME', 'GITHUB_EMAIL', 'GITHUB_TOKEN') {
  if (-not $cfg.ContainsKey($k) -or [string]::IsNullOrEmpty($cfg[$k])) { Fail "$configPath is missing $k" }
}
if ($cfg['GITHUB_TOKEN'] -match '\s') { Fail "GITHUB_TOKEN in $configPath contains whitespace" }

function Read-ManagedJson([string]$Path, [string]$Hint) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "$Path not found. $Hint" }
  try { return [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json }
  catch { Fail "$Path is not valid JSON" }
}

# The Claude placeholder: a real token must never reach the guest.
$claudePath = Join-Path $shareRoot 'credentials.json'
$claude = Read-ManagedJson $claudePath "Run 'susentorno update-shares' on the host first."
if (-not $claude.claudeAiOauth -or $claude.claudeAiOauth.accessToken -ne 'sk-ant-oat-susentorno-PLACEHOLDER') {
  Fail "$claudePath is not the managed Claude placeholder credential"
}

# The Codex placeholder: ChatGPT mode, placeholder tokens, and no API key.
$codexPath = Join-Path $shareRoot 'auth.json'
$codex = Read-ManagedJson $codexPath "Run 'susentorno update-shares' on the host first."
if ($codex.auth_mode -ne 'chatgpt') { Fail "$codexPath is not chatgpt-mode" }
if ($codex.OPENAI_API_KEY) { Fail "$codexPath carries an OPENAI_API_KEY; only the managed placeholder is allowed" }
$codexTokens = $codex.tokens
if (-not $codexTokens -or -not $codexTokens.access_token -or -not $codexTokens.id_token -or
    $codexTokens.refresh_token -ne 'susentorno-placeholder-codex-refresh-token') {
  Fail "$codexPath is not the managed Codex placeholder credential"
}

# --- GitHub identity and auth (git and gh are installed by 01-install-packages.ps1) ---

git config --global user.name $cfg['GITHUB_USERNAME']
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "git config --global user.name exited $status" }
git config --global user.email $cfg['GITHUB_EMAIL']
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "git config --global user.email exited $status" }

$cfg['GITHUB_TOKEN'] | gh auth login --hostname github.com --git-protocol https --with-token
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "gh auth login --hostname github.com exited $status" }
gh auth setup-git --hostname github.com
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "gh auth setup-git --hostname github.com exited $status" }

# --- Placeholder credentials ---

# Stage next to the destination and replace it in one step, so a replay never leaves a
# half-written credential. Every replay refreshes both files, including Codex's account id
# after a host workspace switch (this is a copy, not a link into the share).
function Install-ManagedFile([string]$Source, [string]$DestinationDir, [string]$Name) {
  New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
  $destination = Join-Path $DestinationDir $Name
  $staging = Join-Path $DestinationDir ("$Name.{0}.tmp" -f [guid]::NewGuid().ToString('N'))
  try {
    [System.IO.File]::WriteAllBytes($staging, [System.IO.File]::ReadAllBytes($Source))
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
      [System.IO.File]::Replace($staging, $destination, [NullString]::Value)
    } else {
      [System.IO.File]::Move($staging, $destination)
    }
    try { $null = [System.IO.File]::ReadAllText($destination) | ConvertFrom-Json }
    catch { Fail "the installed $destination is not valid JSON" }
  } finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue }
  }
}

Install-ManagedFile $claudePath (Join-Path $env:USERPROFILE '.claude') '.credentials.json'
Install-ManagedFile $codexPath (Join-Path $env:USERPROFILE '.codex') 'auth.json'

Write-Host "01-auth-config: git identity and gh auth configured for $($cfg['GITHUB_USERNAME']) <$($cfg['GITHUB_EMAIL'])>; placeholder claude + codex credentials installed"
