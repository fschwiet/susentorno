#Requires -RunAsAdministrator
param([Parameter(Mandatory = $true)][string]$HostIp, [string]$CertPath)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$shareRoot = Split-Path -Parent $scriptDir
if (-not $CertPath) { $CertPath = Join-Path $shareRoot 'cert.pem' }

if (-not (Test-Path $CertPath)) {
  Write-Error "05-configure-network: $CertPath not found. Run 'susentorno generate-ca' on the host first."
  exit 1
}

# --- Trust the proxy CA ---

# 1) Windows machine Root store — covers .NET (uses the store) and schannel.
certutil -f -addstore Root $CertPath | Out-Null

# 2) Node tools (claude/codex) ignore the Windows store, so point NODE_EXTRA_CA_CERTS
#    at a stable copy. Machine scope so every new shell inherits it.
$caDir = 'C:\ProgramData\susentorno'
New-Item -ItemType Directory -Force -Path $caDir | Out-Null
$caStable = Join-Path $caDir 'proxy-ca.pem'
Copy-Item -Force $CertPath $caStable
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $caStable, 'Machine')

# 3) Git for Windows: use the Windows store (schannel).
git config --global http.sslBackend schannel

Write-Host "05-configure-network: imported $CertPath into LocalMachine\Root; NODE_EXTRA_CA_CERTS=$caStable; git sslBackend=schannel"

# DNS and the default route now arrive via DHCP from the host (option 6 and option
# 3), so there is nothing to configure here. The adapter stays on DHCP for both the
# NAT and isolated networks, which makes switching between them a pure host operation.
Clear-DnsClientCache
Write-Host "05-configure-network: CA trusted; DNS and addressing come from the host via DHCP"
