# Read-only diagnostics for the Windows sandbox guest's isolation configuration.
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

$PLACEHOLDER = 'sk-ant-oat-SANDBOX-PLACEHOLDER'
Section 'Host IP'
if ($HostIp) { Ok "using host IP $HostIp" } else { Bad 'host IP supplied' 'pass the Internal-switch host IP' }

Section 'CA trust (05)'
$root = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like '*configamatron-proxy-certificate-authority*' }
if ($root) { Ok 'proxy CA present in LocalMachine\Root' } else { Bad 'proxy CA present in LocalMachine\Root' 'certutil import missing?' }
$nodeCa = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'Machine')
if ($nodeCa -and (Test-Path $nodeCa)) { Ok "NODE_EXTRA_CA_CERTS set ($nodeCa)" } else { Bad 'NODE_EXTRA_CA_CERTS set and file exists' "got '$nodeCa'" }
$sslBackend = (git config --global http.sslBackend) 2>$null
if ($sslBackend -eq 'schannel') { Ok 'git http.sslBackend=schannel' } else { Bad 'git http.sslBackend=schannel' "got '$sslBackend'" }

Section 'Host DHCP/DNS (05)'
$dnsServers = Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique
if ($HostIp -and $dnsServers -contains $HostIp) { Ok "resolver points at the host ($HostIp)" } else { Bad "resolver points at the host ($HostIp)" "got '$($dnsServers -join ', ')'" }
if ($HostIp) {
  $ans = (Resolve-DnsName -Name example.com -Type A -DnsOnly -ErrorAction SilentlyContinue | Where-Object Type -eq 'A' | Select-Object -First 1).IPAddress
  if ($ans -eq $HostIp) { Ok "names resolve to the host ($ans)" } else { Bad 'names resolve to the host' "example.com -> '$ans', expected $HostIp" }
}
if (-not (Get-ScheduledTask -TaskName 'ConfigamatronDnsResponder' -ErrorAction SilentlyContinue)) { Ok 'no in-guest DNS responder task' } else { Bad 'no in-guest DNS responder task' 'remove ConfigamatronDnsResponder' }

Section 'Placeholder credential (06)'
$cred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
if (-not (Test-Path $cred)) { Bad 'placeholder credential in place' "missing $cred -- run 06-auth-config.ps1" }
elseif ((Get-Content $cred -Raw).Contains($PLACEHOLDER)) { Ok 'credentials.json is the placeholder' }
else { Bad 'credentials.json is the placeholder' 'a NON-placeholder token is present -- must never live in the guest' }

Section 'Live egress'
function HttpCode($url, $timeout) { & curl.exe -s -o NUL -w '%{http_code}' --max-time $timeout $url }
$c = HttpCode 'http://archive.ubuntu.com/' 20
if ($c -and [int]$c -lt 400) { Ok "allow-listed :80 archive.ubuntu.com -> $c" } else { Bad 'allow-listed :80 archive.ubuntu.com' "code=$c" }
$c = HttpCode 'https://pypi.org/simple/' 30
if ($c -and [int]$c -lt 400) { Ok "allow-listed :443 pypi.org -> $c" } else { Bad 'allow-listed :443 pypi.org' "code=$c" }
& curl.exe -s -o NUL --max-time 20 https://blocked.example.com/ 2>$null
if ($LASTEXITCODE -ne 0) { Ok "blocked :443 connection dropped (curlExit=$LASTEXITCODE)" } else { Bad 'blocked :443 connection dropped' 'curl succeeded; expected a connection failure' }
$c = HttpCode 'http://blocked.example.com/' 20
if ($c -eq '403') { Ok 'blocked :80 -> 403 (default deny)' } else { Bad 'blocked :80 default deny' "expected 403, got $c" }
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
if (-not $c -or $c -eq '000') { Bad 'credential gate wrong-auth' "no response from upstream (code=$c)" }
elseif ([int]$c -lt 400) { Bad 'credential gate wrong-auth' "got $c -- a guest-supplied credential was upgraded; the real token must never be substituted" }
else { Ok "credential gate: guest credential passed through and rejected upstream ($c)" }

Write-Host "`n$script:pass passed, $script:fail failed, $script:warn warnings"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
