$ErrorActionPreference = 'Stop'

# The transformer reads the share and writes only under the user profile, replacing each
# output atomically, so a replay is safe. node and jq are required up front so a missing
# tool is reported as such rather than as a transformer failure.

function Fail([string]$Message) { throw "02-apply-home-jq-transforms: $Message" }

foreach ($tool in 'node', 'jq') {
  $command = Get-Command $tool -ErrorAction SilentlyContinue
  if (-not $command) { Fail "$tool did not resolve on PATH; the pre-isolation steps must run first" }
  $null = & $command.Source --version
  $status = $LASTEXITCODE
  if ($status -ne 0) { Fail "$tool --version exited $status" }
}

$shareRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'apply-home-jq-transforms.mjs') (Join-Path $shareRoot 'home-jq-transforms')
$status = $LASTEXITCODE
if ($status -ne 0) {
  [Console]::Error.WriteLine("02-apply-home-jq-transforms: the transformer exited $status")
  exit $status
}
