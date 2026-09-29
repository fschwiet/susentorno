#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Runs while the VM is still on the Default Switch (pre-isolation), in a fresh elevated
# Windows PowerShell 5.1 process. PowerShell 5.1 does not turn a failing native command
# into an error, so every native call below is followed at once by a status check.
#
# Only what a susentorno guest requires (see ADR-0024): jq for the home settings
# transforms, git for configure-network and 01-auth-config, gh for 01-auth-config.
# Developer tooling belongs in the user's own pre-scripts/. This step deliberately does
# not upgrade App Installer, change WinGet settings, or upgrade unrelated packages.

function Fail([string]$Message) { throw "01-install-packages: $Message" }

# WinGet reports "no installed package matches" as APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND
# (0x8A150014). This is the only nonzero status accepted, and only from the read-only
# `winget list` probe below. Every install status other than 0, including "already
# installed", "no applicable upgrade", and every reboot-required result, is a failure.
$WingetPackageAbsent = -1978335212

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
    Write-Host "01-install-packages: $Id is already installed"
    return
  }
  Write-Host "01-install-packages: installing $Id"
  & $winget install --id $Id --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity --source winget
  $status = $LASTEXITCODE
  if ($status -ne 0) { Fail "winget install --id $Id exited $status" }
}

# Rebuild only this process's PATH from the persisted machine and user values, so the
# postcondition checks see what the installers wrote. Nothing is written back.
function Update-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Assert-ToolVersion([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { Fail "$Name did not resolve on the persisted PATH after install" }
  $output = & $command.Source --version
  $status = $LASTEXITCODE
  if ($status -ne 0) { Fail "$Name --version exited $status" }
  Write-Host "01-install-packages: $Name resolves to $($command.Source) ($(@($output)[0]))"
}

$packages = @(
  'jqlang.jq',
  'Git.Git',
  'GitHub.cli'
)

foreach ($id in $packages) { Install-WingetPackage $id }

Update-ProcessPath
foreach ($tool in 'jq', 'git', 'gh') { Assert-ToolVersion $tool }

Write-Host '01-install-packages: required packages are installed and resolve'
