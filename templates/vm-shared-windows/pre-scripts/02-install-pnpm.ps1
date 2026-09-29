#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Standalone pnpm (no Node required yet). Mirrors Ubuntu 02-install-pnpm.sh. Runs in a
# fresh elevated Windows PowerShell 5.1 process whose per-process execution policy is
# Bypass; the guest's persistent policy is never touched, and nothing is staged under the
# UNC share. PowerShell 5.1 does not turn a failing native command into an error, so every
# native call is followed at once by a status check.

function Fail([string]$Message) { throw "02-install-pnpm: $Message" }

# The runner starts every step in the read-only UNC phase directory, and pnpm 12 panics
# there ("current dir is an absolute path with drive letter"). Nothing in this step uses a
# relative path, so run from the local profile directory instead.
Set-Location -LiteralPath $env:USERPROFILE

# pnpm.exe (v12 and later) links the Visual C++ runtime dynamically. A clean Windows
# install lacks it, and then pnpm.exe dies with 0xC0000135 while the official bootstrap
# still exits 0 (it ignores the failure of its own `pnpm setup`). Install the runtime
# first, and only when vcruntime140.dll is absent.
$vcRuntime = Join-Path ([Environment]::SystemDirectory) 'vcruntime140.dll'
if (-not (Test-Path -LiteralPath $vcRuntime -PathType Leaf)) {
  $winget = (Get-Command winget -ErrorAction SilentlyContinue).Source
  if (-not $winget) { $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe' }
  if (-not (Test-Path -LiteralPath $winget -PathType Leaf)) {
    Fail 'winget was not found; the guest needs a usable App Installer before setup'
  }
  Write-Host '02-install-pnpm: installing Microsoft.VCRedist.2015+.x64 (pnpm needs vcruntime140.dll)'
  & $winget install --id 'Microsoft.VCRedist.2015+.x64' --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity --source winget
  $status = $LASTEXITCODE
  if ($status -ne 0) { Fail "winget install --id Microsoft.VCRedist.2015+.x64 exited $status" }
  if (-not (Test-Path -LiteralPath $vcRuntime -PathType Leaf)) {
    Fail "Microsoft.VCRedist.2015+.x64 installed but $vcRuntime is still missing"
  }
}

# Stage the official bootstrap in a unique temp file, run it in its own noninteractive
# process, and always remove the file.
$bootstrap = Join-Path ([System.IO.Path]::GetTempPath()) ("susentorno-pnpm-install-{0}.ps1" -f [guid]::NewGuid().ToString('N'))
$cleanupFailure = $null
try {
  try { Invoke-WebRequest -Uri 'https://get.pnpm.io/install.ps1' -UseBasicParsing -OutFile $bootstrap }
  catch { Fail "downloading the pnpm bootstrap failed: $($_.Exception.Message)" }

  & (Join-Path $PSHOME 'powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $bootstrap
  $status = $LASTEXITCODE
  if ($status -ne 0) { Fail "the pnpm bootstrap exited $status" }
} finally {
  if (Test-Path -LiteralPath $bootstrap) {
    try { Remove-Item -LiteralPath $bootstrap -Force -ErrorAction Stop }
    catch {
      $cleanupFailure = "could not remove the temporary bootstrap ${bootstrap}: $($_.Exception.Message)"
      Write-Warning "02-install-pnpm: $cleanupFailure"
    }
  }
}
if ($cleanupFailure) { Fail $cleanupFailure }

# The bootstrap persists PNPM_HOME and a PATH entry (usually %PNPM_HOME%\bin) for the user.
# Verify those persisted values, not this process's environment: the next step starts in a
# fresh process and must find pnpm from them alone. Only this process is refreshed, for
# the check below.
$pnpmHome = [Environment]::GetEnvironmentVariable('PNPM_HOME', 'User')
if (-not $pnpmHome) { Fail 'the bootstrap did not persist a user PNPM_HOME' }
$env:PNPM_HOME = $pnpmHome

# The persisted PATH may reference %PNPM_HOME%, which expands only now that it is set here.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$persistedEntries = @($userPath -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
$homeEntries = @($persistedEntries | Where-Object { $_ -eq $pnpmHome.TrimEnd('\') -or $_ -like ($pnpmHome.TrimEnd('\') + '\*') })
if ($homeEntries.Count -eq 0) {
  Fail "the persisted user PATH has no entry under PNPM_HOME ($pnpmHome)"
}
$env:Path = (@([Environment]::GetEnvironmentVariable('Path', 'Machine'), $userPath) | Where-Object { $_ }) -join ';'

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) { Fail 'pnpm does not resolve from the persisted PNPM_HOME and PATH' }
if (-not $pnpm.Source.StartsWith($pnpmHome.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  Fail "pnpm resolves to $($pnpm.Source), outside the persisted PNPM_HOME ($pnpmHome)"
}
$version = & $pnpm.Source --version
$status = $LASTEXITCODE
if ($status -ne 0) { Fail "pnpm --version exited $status" }

Write-Host "02-install-pnpm: pnpm $(@($version)[0]) resolves from the persisted PNPM_HOME ($pnpmHome)"
