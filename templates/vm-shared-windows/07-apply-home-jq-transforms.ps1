$ErrorActionPreference = 'Stop'

& node (Join-Path $PSScriptRoot 'apply-home-jq-transforms.mjs') (Join-Path $PSScriptRoot 'home-jq-transforms')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
