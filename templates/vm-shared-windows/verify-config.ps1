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
$installDir = 'C:\ProgramData\configamatron\dns-responder'
$configFile = Join-Path $installDir 'responder-config.txt'

Section 'Host IP'
$configuredIp = if (Test-Path $configFile) { (Get-Content $configFile -Raw).Trim() } else { '' }
if ($HostIp) {
  if ($configuredIp -eq $HostIp) { Ok "responder config matches requested host IP ($HostIp)" }
  else { Bad 'responder config matches requested host IP' "requested $HostIp, config has '$configuredIp'" }
}
elseif ($configuredIp) { $HostIp = $configuredIp; Ok "discovered host IP from responder config: $HostIp" }
else { Bad 'host IP determinable' 'no responder config and no host-ip arg -- has 07-setup-network.ps1 run?' }

Section 'CA trust (06)'
$root = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like '*configamatron-proxy-certificate-authority*' }
if ($root) { Ok 'proxy CA present in LocalMachine\Root' } else { Bad 'proxy CA present in LocalMachine\Root' 'certutil import missing?' }
$nodeCa = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'Machine')
if ($nodeCa -and (Test-Path $nodeCa)) { Ok "NODE_EXTRA_CA_CERTS set ($nodeCa)" } else { Bad 'NODE_EXTRA_CA_CERTS set and file exists' "got '$nodeCa'" }
$sslBackend = (git config --global http.sslBackend) 2>$null
if ($sslBackend -eq 'schannel') { Ok 'git http.sslBackend=schannel' } else { Bad 'git http.sslBackend=schannel' "got '$sslBackend'" }

Section 'DNS redirect (07)'
$task = Get-ScheduledTask -TaskName 'ConfigamatronDnsResponder' -ErrorAction SilentlyContinue
if ($task) { Ok 'responder scheduled task registered' } else { Bad 'responder scheduled task registered' 'Register-ScheduledTask not run?' }
$listening = Get-NetUDPEndpoint -LocalPort 53 -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue
if ($listening) { Ok 'responder listening on 127.0.0.1:53' } else { Bad 'responder listening on 127.0.0.1:53' 'responder process not running?' }
$dnsServers = Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique
if ($dnsServers -contains '127.0.0.1') { Ok 'adapter DNS includes 127.0.0.1' } else { Bad 'adapter DNS includes 127.0.0.1' "got '$($dnsServers -join ', ')'" }
$extra = $dnsServers | Where-Object { $_ -ne '127.0.0.1' }
if (-not $extra) { Ok 'no DNS server besides 127.0.0.1' } else { Bad 'no DNS server besides 127.0.0.1' "extra: $($extra -join ', ')" }
if ($HostIp) {
  try {
    $ans = (Resolve-DnsName -Name example.com -Server 127.0.0.1 -Type A -DnsOnly -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
    if ($ans -eq $HostIp) { Ok "stub answers example.com -> $HostIp" } else { Bad 'stub answers example.com -> host IP' "got '$ans'" }
  }
  catch { Bad 'stub answers example.com -> host IP' $_.Exception.Message }
}

Section 'Placeholder credential (08)'
$cred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
if (-not (Test-Path $cred)) { Bad 'placeholder credential in place' "missing $cred -- run 08-claude-config.ps1" }
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
$c = & curl.exe -s -o NUL -w '%{http_code}' --max-time 20 -H 'Authorization: Bearer not-the-placeholder' https://api.anthropic.com/
if ($c -eq '403') { Ok 'credential gate: wrong Authorization -> 403 (no token spent)' } else { Bad 'credential gate wrong-auth' "expected 403 from gate.lua, got $c" }

Write-Host "`n$script:pass passed, $script:fail failed, $script:warn warnings"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
