$ErrorActionPreference = 'Stop'

$shareRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'apply-home-jq-transforms.mjs') (Join-Path $shareRoot 'home-jq-transforms')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
