#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

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
#
# Only what a susentorno guest requires (see ADR-0024): jq for the home settings
# transforms, git for configure-network and 01-auth-config, gh for 01-auth-config.
# Developer tooling belongs in the user's own pre-scripts/.
$packages = @(
  'jqlang.jq',
  'Git.Git',
  'GitHub.cli'
)

foreach ($id in $packages) {
  Write-Host "01-install-packages: installing $id"
  winget install --id $id --exact --silent --accept-source-agreements --accept-package-agreements --source winget
}

Write-Host "01-install-packages: required packages installed. Open a new terminal so PATH updates apply."
