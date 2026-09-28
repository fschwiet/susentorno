# Read-only diagnostics for the Windows guest's isolation configuration.
# Usage: powershell -File verify-config.ps1 [host-ip]
#   host-ip  Expected proxy host IP. If omitted, it is discovered from the
#            installed responder config and reported. If given, the config is
#            asserted to match it.
# Prints one PASS/FAIL/WARN line per check; exits non-zero if any FAIL.
param([string]$HostIp)

$script:pass = 0; $script:fail = 0; $script:warn = 0
function Section($t) { Write-Host "`n== $t ==" }
function Ok($m) { $script:pass++; Write-Host "  PASS  $m" }
function Bad($m, $d) { $script:fail++; if ($d) { Write-Host "  FAIL  $m -- $d" } else { Write-Host "  FAIL  $m" } }
function Adv($m, $d) { $script:warn++; if ($d) { Write-Host "  WARN  $m -- $d" } else { Write-Host "  WARN  $m" } }

$PLACEHOLDER = 'sk-ant-oat-susentorno-PLACEHOLDER'

# The DHCP-assigned DNS server is a reliable stand-in for "the host IP" on
# this branch's host-side-DNS design: the host serves both DNS and the
# gateway from the same address. Reusing it here (rather than picking among
# possibly-multiple default routes by metric) avoids a whole class of
# ambiguity a route-based discovery would have to resolve.
#
# Wrapped in @(...): with exactly one result, the pipeline below returns a
# bare [string], not a 1-element array. PowerShell strings also expose a
# .Count property (always 1), so ".Count -eq 1" below would still look
# right -- but $dnsServers[0] on a bare string indexes its first *character*
# (a System.Char), not the address, silently corrupting $HostIp. @(...)
# forces array semantics regardless of how many results come back.
$dnsServers = @(Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique)

Section 'Host IP'
if ($HostIp) {
  Ok "using host IP $HostIp"
} elseif ($dnsServers.Count -eq 1) {
  $HostIp = $dnsServers[0]
  Ok "discovered host IP $HostIp from the DHCP-assigned DNS server"
} else {
  Bad 'host IP determinable' "pass -HostIp explicitly -- found $($dnsServers.Count) DHCP-assigned DNS server(s) ('$($dnsServers -join ', ')'), need exactly 1 to discover unambiguously"
}

Section 'CA trust (reconciled by setup-guest-windows, verified by configure-network)'
# Trust is reconciled from the host by 'susentorno setup-guest-windows' and recorded under
# C:ProgramDatasusentorno	rust. Everything here compares DER SHA-256 fingerprints, never
# subjects, and never repairs anything.
$trustDir = 'C:ProgramDatasusentorno	rust'
$manifestPath = Join-Path $trustDir 'manifest.json'
$bundlePath = Join-Path $trustDir 'node-extra-ca-bundle.pem'
function Get-Sha256Hex([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha.Dispose() }
}
function Get-PemFingerprints([string]$Text) {
  $blocks = [regex]::Matches($Text, '-----BEGIN CERTIFICATE-----(?<body>[A-Za-z0-9+/=s]+?)-----END CERTIFICATE-----')
  return @($blocks | ForEach-Object { Get-Sha256Hex ([Convert]::FromBase64String(($_.Groups['body'].Value -replace 's', ''))) })
}
$certPath = Join-Path $PSScriptRoot 'cert.pem'
$proxy = $null
if (Test-Path -LiteralPath $certPath -PathType Leaf) {
  $proxyFingerprints = @(Get-PemFingerprints ([System.IO.File]::ReadAllText($certPath)))
  if ($proxyFingerprints.Count -eq 1) { $proxy = $proxyFingerprints[0] }
}
if ($proxy) { Ok "environment proxy CA fingerprint $($proxy.Substring(0, 12))" } else { Bad 'environment proxy CA fingerprint' "$certPath is missing or does not hold exactly one certificate" }

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
$store.Open('ReadOnly')
try { $rootFingerprints = @($store.Certificates | ForEach-Object { Get-Sha256Hex $_.RawData }) } finally { $store.Close() }
if ($proxy -and ($rootFingerprints -contains $proxy)) { Ok 'proxy CA present in LocalMachineRoot' } else { Bad 'proxy CA present in LocalMachineRoot' 'rerun susentorno setup-guest-windows' }

$manifest = $null
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
  try { $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json } catch { $manifest = $null }
}
if ($manifest -and $proxy -and $manifest.proxy -eq $proxy) { Ok 'trust manifest names the proxy CA' } else { Bad 'trust manifest names the proxy CA' "missing, unreadable, or names another CA ($manifestPath)" }

$nodeCa = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'Machine')
if ($nodeCa -eq $bundlePath) { Ok "NODE_EXTRA_CA_CERTS names the combined bundle ($nodeCa)" } else { Bad 'NODE_EXTRA_CA_CERTS names the combined bundle' "got '$nodeCa', expected '$bundlePath'" }

if ($manifest -and $proxy -and (Test-Path -LiteralPath $bundlePath -PathType Leaf)) {
  $found = @(Get-PemFingerprints ([System.IO.File]::ReadAllText($bundlePath)))
  $expected = @(@($manifest.ambient) + @($proxy) | Where-Object { $_ } | Sort-Object -Unique)
  $missing = @($expected | Where-Object { $found -notcontains $_ })
  $extra = @($found | Where-Object { $expected -notcontains $_ })
  $duplicates = $found.Count - @($found | Sort-Object -Unique).Count
  if ($missing.Count -eq 0 -and $extra.Count -eq 0 -and $duplicates -eq 0) { Ok "bundle holds the manifest's $($expected.Count) certificate(s), once each" }
  else { Bad 'bundle matches the manifest' "missing $($missing.Count), unexpected $($extra.Count), duplicates $duplicates" }
} else {
  Bad 'bundle matches the manifest' 'the bundle, the manifest, or the proxy fingerprint is unavailable'
}

$sslBackend = (git config --global http.sslBackend) 2>$null
$gitExit = $LASTEXITCODE
if ($gitExit -eq 0 -and $sslBackend -eq 'schannel') { Ok 'git http.sslBackend=schannel' } else { Bad 'git http.sslBackend=schannel' "got '$sslBackend' (git exit $gitExit)" }

Section 'Host DHCP/DNS (configure-network)'
if ($HostIp -and $dnsServers -contains $HostIp) { Ok "resolver points at the host ($HostIp)" } else { Bad "resolver points at the host ($HostIp)" "got '$($dnsServers -join ', ')'" }
if ($HostIp) {
  $ans = (Resolve-DnsName -Name example.com -Type A -DnsOnly -ErrorAction SilentlyContinue | Where-Object Type -eq 'A' | Select-Object -First 1).IPAddress
  if ($ans -eq $HostIp) { Ok "names resolve to the host ($ans)" } else { Bad 'names resolve to the host' "example.com -> '$ans', expected $HostIp" }
}
if (-not (Get-ScheduledTask -TaskName 'SusentornoDnsResponder' -ErrorAction SilentlyContinue)) { Ok 'no in-guest DNS responder task' } else { Bad 'no in-guest DNS responder task' 'remove SusentornoDnsResponder' }

Section 'Placeholder credential (01-auth-config)'
$cred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
if (-not (Test-Path $cred)) { Bad 'placeholder credential in place' "missing $cred -- run 01-auth-config.ps1" }
elseif ((Get-Content $cred -Raw).Contains($PLACEHOLDER)) { Ok 'credentials.json is the placeholder' }
else { Bad 'credentials.json is the placeholder' 'a NON-placeholder token is present -- must never live in the guest' }

Section 'Live egress'
# The curl status is captured on the line after the call and left in $script:curlExit.
function HttpCode($url, $timeout) { $code = & curl.exe -s -o NUL -w '%{http_code}' --max-time $timeout $url; $script:curlExit = $LASTEXITCODE; return $code }
$c = HttpCode 'http://archive.ubuntu.com/' 20
$archiveExit = $script:curlExit
if ($c -and [int]$c -lt 400 -and $archiveExit -eq 0) { Ok "allow-listed :80 archive.ubuntu.com -> $c" } else { Bad 'allow-listed :80 archive.ubuntu.com' "code=$c curlExit=$archiveExit" }
$c = HttpCode 'https://pypi.org/' 30
$pypiExit = $script:curlExit
if ($c -and [int]$c -lt 400 -and $pypiExit -eq 0) { Ok "allow-listed :443 pypi.org -> $c" } else { Bad 'allow-listed :443 pypi.org' "code=$c curlExit=$pypiExit" }
& curl.exe -s -o NUL --max-time 20 https://blocked.example.com/ 2>$null
$blockedExit = $LASTEXITCODE
if ($blockedExit -ne 0) { Ok "blocked :443 connection dropped (curlExit=$blockedExit)" } else { Bad 'blocked :443 connection dropped' 'curl succeeded; expected a connection failure' }
$c = HttpCode 'http://blocked.example.com/' 20
$defaultDenyExit = $script:curlExit
if ($c -eq '403') { Ok 'blocked :80 -> 403 (default deny)' } else { Bad 'blocked :80 default deny' "expected 403, got $c (curlExit=$defaultDenyExit)" }
# gate.lua swaps ONLY an exact placeholder match for the real token; any other
# Authorization passes through to the upstream unmodified (it no longer 403s an
# unexpected credential -- see docs/investigations/2026-07-22-remote-control-session-
# token-rejected-by-claude-gate.md). So a guest-supplied credential must reach the
# upstream and be REJECTED there.
#
# /v1/models, not "/": "/" answers 404 whatever the credential, so it cannot tell a
# rejected credential from an injected one. Asserting >=400 rather than a specific
# code keeps this robust to upstream changes -- the outcome that must never happen is
# a 2xx, which would mean the real token had been substituted for a guest's own.
#
# --ssl-no-revoke: api.anthropic.com is MITM'd with the proxy's leaf cert, which has
# no CRL/OCSP endpoint. schannel (Windows curl) does a revocation check by default and
# fails closed when it finds none, aborting the handshake (curl returns 000). Real
# agent traffic uses OpenSSL, which doesn't do this.
$c = & curl.exe -s -o NUL -w '%{http_code}' --ssl-no-revoke --max-time 20 `
    -H 'Authorization: Bearer not-the-placeholder' -H 'anthropic-version: 2023-06-01' `
    https://api.anthropic.com/v1/models
$gateExit = $LASTEXITCODE
if (-not $c -or $c -eq '000' -or $gateExit -ne 0) { Bad 'credential gate wrong-auth' "no response from upstream (code=$c curlExit=$gateExit)" }
elseif ([int]$c -lt 400) { Bad 'credential gate wrong-auth' "got $c -- a guest-supplied credential was upgraded; the real token must never be substituted" }
else { Ok "credential gate: guest credential passed through and rejected upstream ($c)" }

Write-Host "`n$script:pass passed, $script:fail failed, $script:warn warnings"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
