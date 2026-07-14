#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

# winget ships with Windows 11. Install non-interactively. Native non-zero exit
# codes (e.g. "package already installed") do not throw in PowerShell, so a
# re-run is safe. Runs while the VM is still on NAT (pre-isolation).
$packages = @(
  'Git.Git',
  'Microsoft.PowerShell',      # PowerShell 7 (pwsh)
  'Microsoft.DotNet.SDK.10',   # .NET SDK
  'GitHub.cli'                 # gh
)
foreach ($id in $packages) {
  Write-Host "01-install-packages: installing $id"
  winget install --id $id --exact --silent --accept-source-agreements --accept-package-agreements
}

Write-Host "01-install-packages: core packages installed. Open a new terminal so PATH updates apply."
