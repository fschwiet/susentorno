#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$certPath = if ($args.Count -ge 1) { $args[0] } else { Join-Path $scriptDir 'cert.pem' }

if (-not (Test-Path $certPath)) {
  Write-Error "06-trust-ca: $certPath not found. Run 'configamatron generate-ca' on the host first."
  exit 1
}

# 1) Windows machine Root store — covers .NET (uses the store) and schannel.
#    certutil accepts base64 PEM directly.
certutil -f -addstore Root $certPath | Out-Null

# 2) Node tools (claude/codex) ignore the Windows store, so point NODE_EXTRA_CA_CERTS
#    at a stable copy. Machine scope so every new shell inherits it.
$caDir = 'C:\ProgramData\configamatron'
New-Item -ItemType Directory -Force -Path $caDir | Out-Null
$caStable = Join-Path $caDir 'proxy-ca.pem'
Copy-Item -Force $certPath $caStable
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $caStable, 'Machine')

# 3) Git for Windows: use the Windows store (schannel) instead of its bundled
#    OpenSSL CA list, which the certutil import above now populates.
git config --global http.sslBackend schannel

Write-Host "06-trust-ca: imported $certPath into LocalMachine\Root; NODE_EXTRA_CA_CERTS=$caStable; git sslBackend=schannel"
