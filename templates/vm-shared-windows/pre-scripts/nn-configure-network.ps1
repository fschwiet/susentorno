#Requires -RunAsAdministrator
# Verifies the trust that `susentorno setup-guest-windows` reconciled, then configures Git.
# Trust has one owner, the host-driven reconciliation that runs before any step: this
# script never imports a certificate, writes a trust file, or changes the machine
# environment. Missing or mismatched trust is a failure here, never something to repair.
param([Parameter(Mandatory = $true)][string]$HostIp)
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) { throw "configure-network: $Message" }

# HostIp is validated but not used: addressing and DNS arrive from the host over DHCP, and
# the Internal-switch lease does not exist yet while this step runs on the Default Switch.
$octets = $HostIp.Split('.')
if ($octets.Count -ne 4 -or ($octets | Where-Object { $_ -notmatch '^\d{1,3}$' -or [int]$_ -gt 255 })) {
  Fail "-HostIp '$HostIp' is not an IPv4 address"
}

$trustDir = 'C:\ProgramData\susentorno\trust'
$manifestPath = Join-Path $trustDir 'manifest.json'
$bundlePath = Join-Path $trustDir 'node-extra-ca-bundle.pem'

function Get-Sha256Hex([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha.Dispose() }
}

function Get-PemFingerprints([string]$Text) {
  $blocks = [regex]::Matches($Text, '-----BEGIN CERTIFICATE-----(?<body>[A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----')
  return @($blocks | ForEach-Object { Get-Sha256Hex ([Convert]::FromBase64String(($_.Groups['body'].Value -replace '\s', ''))) })
}

# The environment's proxy CA is the certificate this share was generated with.
$shareRoot = Split-Path -Parent $PSScriptRoot
$certPath = Join-Path $shareRoot 'cert.pem'
if (-not (Test-Path -LiteralPath $certPath -PathType Leaf)) {
  Fail "$certPath not found. Run 'susentorno generate-ca' and 'susentorno update-shares' on the host first."
}
$proxyFingerprints = @(Get-PemFingerprints ([System.IO.File]::ReadAllText($certPath)))
if ($proxyFingerprints.Count -ne 1) { Fail "$certPath must hold exactly one certificate" }
$proxy = $proxyFingerprints[0]

# 1) The proxy CA is in LocalMachine\Root.
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
$store.Open('ReadOnly')
try { $rootFingerprints = @($store.Certificates | ForEach-Object { Get-Sha256Hex $_.RawData }) }
finally { $store.Close() }
if ($rootFingerprints -notcontains $proxy) {
  Fail "the proxy CA ($($proxy.Substring(0, 12))) is not in LocalMachine\Root; trust reconciliation did not run or did not finish"
}

# 2) The manifest names that proxy CA.
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Fail "the trust manifest $manifestPath is missing" }
try { $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json }
catch { Fail "the trust manifest $manifestPath is not valid JSON" }
if ($manifest.proxy -ne $proxy) {
  Fail "the trust manifest names a different proxy CA than this environment's cert.pem ($($proxy.Substring(0, 12)) expected)"
}

# 3) Machine NODE_EXTRA_CA_CERTS names the combined bundle.
$nodeCa = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'Machine')
if ($nodeCa -ne $bundlePath) { Fail "machine NODE_EXTRA_CA_CERTS is '$nodeCa', expected '$bundlePath'" }

# 4) The bundle holds exactly the manifest's ambient roots plus the proxy CA, each once.
if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) { Fail "the combined bundle $bundlePath is missing" }
$found = @(Get-PemFingerprints ([System.IO.File]::ReadAllText($bundlePath)))
if ($found.Count -ne @($found | Sort-Object -Unique).Count) { Fail 'the combined bundle contains a duplicate certificate' }
$expected = @(@($manifest.ambient) + @($proxy) | Where-Object { $_ } | Sort-Object -Unique)
$missing = @($expected | Where-Object { $found -notcontains $_ })
$extra = @($found | Where-Object { $expected -notcontains $_ })
if ($missing.Count -gt 0) { Fail "the combined bundle is missing $($missing.Count) certificate(s) the manifest lists" }
if ($extra.Count -gt 0) { Fail "the combined bundle holds $($extra.Count) certificate(s) the manifest does not list" }

# 5) Git for Windows validates through the Windows store (schannel).
git config --global http.sslBackend schannel
if ($LASTEXITCODE -ne 0) { Fail "git config --global http.sslBackend schannel exited $LASTEXITCODE" }
$sslBackend = git config --global --get http.sslBackend
if ($LASTEXITCODE -ne 0) { Fail "reading git http.sslBackend back exited $LASTEXITCODE" }
if ($sslBackend -ne 'schannel') { Fail "git http.sslBackend reads back as '$sslBackend', expected 'schannel'" }

# DNS and the default route arrive via DHCP from the host (option 6 and option 3), so there
# is nothing to configure here. The adapter stays on DHCP for both the Default Switch and the
# Internal switch, which makes moving between them a pure host operation.
Clear-DnsClientCache
Write-Host "configure-network: trust reconciled (proxy CA $($proxy.Substring(0, 12)), $($found.Count) certificate(s) in the bundle); git sslBackend=schannel; addressing and DNS come from the host via DHCP"
