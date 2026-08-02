# Parses a single PowerShell file and reports any syntax errors, without
# executing it. Invoked once per file by scripts/lint-ps1.mjs.
param(
  [Parameter(Mandatory)]
  [string]$Path
)

$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null

if ($errors.Count -gt 0) {
  foreach ($e in $errors) {
    Write-Output "$($Path):$($e.Extent.StartLineNumber):$($e.Extent.StartColumnNumber): $($e.Message)"
  }
  exit 1
}

exit 0
