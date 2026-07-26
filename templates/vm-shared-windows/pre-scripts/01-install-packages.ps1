#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

wsl --update

try {
  winget settings --enable BypassCertificatePinningForMicrosoftStore
  winget upgrade Microsoft.AppInstaller --accept-source-agreements --accept-package-agreements
} finally {
  winget settings --disable BypassCertificatePinningForMicrosoftStore
}

winget upgrade --all --include-unknown --accept-source-agreements --accept-package-agreements

# winget ships with Windows 11. Install non-interactively. Native non-zero exit
# codes (e.g. "package already installed") do not throw in PowerShell, so a
# re-run is safe. Runs while the VM is still on NAT (pre-isolation).
$packages = @(
  'jqlang.jq',                 # jq - command line json parser, used to update config files
  'Git.Git',
  'Microsoft.PowerShell',      # PowerShell 7 (pwsh)
  'Microsoft.DotNet.SDK.10',   # .NET SDK
  'GitHub.cli',                # gh
  'Microsoft.WindowsTerminal',
  'Microsoft.VisualStudioCode',
  'Docker.DockerDesktop',
  'Python.Python.3.14',        # codex comes bundles with some python helper scripts
  'WinMerge.WinMerge'
)

foreach ($id in $packages) {
  Write-Host "01-install-packages: installing $id"
  winget install --id $id --exact --silent --accept-source-agreements --accept-package-agreements --source winget
}

Write-Host "01-install-packages: core packages installed. Open a new terminal so PATH updates apply."
