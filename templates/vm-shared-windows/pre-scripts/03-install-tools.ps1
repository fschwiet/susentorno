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

# Node runtime managed by pnpm
pnpm runtime set node latest -g
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "pnpm runtime set node latest -g exited $status" }

# Pi Coding Agent
pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "pnpm add -g @earendil-works/pi-coding-agent exited $status" }

# Claude Code CLI: Anthropic's official native installer bootstrap. Staged in a unique temp
# file (never the UNC phase directory), run in its own noninteractive process, and always
# removed. It runs on every setup so the guest follows the current release.
$claudeBootstrap = Join-Path ([System.IO.Path]::GetTempPath()) ("susentorno-claude-install-{0}.ps1" -f [guid]::NewGuid().ToString('N'))
$cleanupFailure = $null
try {
  try { Invoke-WebRequest -Uri 'https://claude.ai/install.ps1' -UseBasicParsing -OutFile $claudeBootstrap }
  catch { Fail "downloading the Claude Code bootstrap failed: $($_.Exception.Message)" }

  & (Join-Path $PSHOME 'powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $claudeBootstrap
  $status = $LASTEXITCODE
  if ($status -ne 0) { Fail "the Claude Code bootstrap exited $status" }
} finally {
  if (Test-Path -LiteralPath $claudeBootstrap) {
    try { Remove-Item -LiteralPath $claudeBootstrap -Force -ErrorAction Stop }
    catch {
      $cleanupFailure = "could not remove the temporary bootstrap ${claudeBootstrap}: $($_.Exception.Message)"
      Write-Warning "03-install-tools: $cleanupFailure"
    }
  }
}
if ($cleanupFailure) { Fail $cleanupFailure }

# Make sure the native install directory is on the persisted user PATH (added once).
$claudeBin = Join-Path $env:USERPROFILE '.local\bin'
$persistedUserPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
$persistedEntries = @($persistedUserPath -split ';' | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
if (-not ($persistedEntries | Where-Object { $_ -ieq $claudeBin.TrimEnd('\') })) {
  $newUserPath = (@($persistedUserPath.TrimEnd(';'), $claudeBin) | Where-Object { $_ }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
  Write-Host "03-install-tools: added $claudeBin to the persisted user PATH"
}

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
