$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Node runtime managed by pnpm, plus the agent CLIs (mirrors Ubuntu 03-install-tools.sh).
# Runs in a fresh elevated Windows PowerShell 5.1 process. PowerShell 5.1 does not turn a
# failing native command into an error, so every native call is followed at once by a
# status check. None of these installs is expected to need a reboot; a reboot-required
# status is a nonzero status and therefore a failure.

function Fail([string]$Message) { throw "03-install-tools: $Message" }

# The runner starts every step in the read-only UNC phase directory, and pnpm 12 panics
# there ("current dir is an absolute path with drive letter"). Nothing in this step uses a
# relative path, so run from the local profile directory instead.
Set-Location -LiteralPath $env:USERPROFILE

# WinGet reports "no installed package matches" as APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND
# (0x8A150014). This is the only nonzero status accepted, and only from the read-only
# `winget list` probe. Every install status other than 0 is a failure.
$WingetPackageAbsent = -1978335212

function Update-ProcessPath {
  $pnpmHome = [Environment]::GetEnvironmentVariable('PNPM_HOME', 'User')
  if ($pnpmHome) { $env:PNPM_HOME = $pnpmHome }
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

# pnpm must already be resolvable in this fresh process from the persisted environment
# that 02-install-pnpm left behind; this step never installs it.
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCommand) { Fail 'pnpm does not resolve on PATH; run 02-install-pnpm.ps1 first' }
$pnpmVersion = & pnpm --version
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "pnpm --version exited $status" }
Write-Host "03-install-tools: pnpm $(@($pnpmVersion)[0])"

$winget = (Get-Command winget -ErrorAction SilentlyContinue).Source
if (-not $winget) { $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe' }
if (-not (Test-Path -LiteralPath $winget -PathType Leaf)) {
  Fail 'winget was not found; the guest needs a usable App Installer before setup'
}

function Test-WingetPackageInstalled([string]$Id) {
  $output = & $winget list --id $Id --exact --source winget --accept-source-agreements --disable-interactivity | Out-String
  $status = $LASTEXITCODE
  if ($status -eq 0) { return $true }
  if ($status -eq $WingetPackageAbsent) { return $false }
  Fail "winget list --id $Id exited ${status}: $($output.Trim())"
}

function Install-WingetPackage([string]$Id) {
  if (Test-WingetPackageInstalled $Id) {
    Write-Host "03-install-tools: $Id is already installed"
    return
  }
  Write-Host "03-install-tools: installing $Id"
  & $winget install --id $Id --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity --source winget
  $status = $LASTEXITCODE
  if ($status -ne 0) { Fail "winget install --id $Id exited $status" }
}

# Node runtime managed by pnpm
pnpm runtime set node latest -g
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "pnpm runtime set node latest -g exited $status" }

# Pi Coding Agent
pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "pnpm add -g @earendil-works/pi-coding-agent exited $status" }

# Claude Code CLI: native Windows installer.
Install-WingetPackage 'Anthropic.ClaudeCode'

# Codex CLI: cross-platform npm package via pnpm.
pnpm add -g @openai/codex
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "pnpm add -g @openai/codex exited $status" }

# Rebuild only this process's environment from the persisted values so the checks see what
# the installers wrote. Nothing is written back.
Update-ProcessPath
foreach ($tool in 'node', 'pi', 'claude', 'codex') {
  $command = Get-Command $tool -ErrorAction SilentlyContinue
  if (-not $command) { Fail "$tool did not resolve on the persisted PATH after install" }
  $output = & $command.Source --version
  $status = $LASTEXITCODE
  if ($status -ne 0) { Fail "$tool --version exited $status" }
  Write-Host "03-install-tools: $tool resolves to $($command.Source) ($(@($output)[0]))"
}

Write-Host '03-install-tools: node runtime, pi-coding-agent, claude, and codex are installed and resolve'
