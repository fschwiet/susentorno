$ErrorActionPreference = 'Stop'

pip install PyYAML # Used by codex to validate YAML

# Standalone pnpm (no Node required yet). Mirrors Ubuntu 02-install-pnpm.sh.
Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing | Invoke-Expression

Write-Host "02-install-pnpm: pnpm installed. Open a new terminal before running 03-install-tools.ps1 so pnpm is on PATH."
