#requires -Version 5.1
<#
Read-only diagnostics for the host-side Envoy proxy. Run from the environment
directory (the folder that owns .configamatron) while the proxy is up:

    powershell -ExecutionPolicy Bypass -File .configamatron\proxy\verify-proxy.ps1

Prints one PASS/FAIL/WARN line per check, with the observed value on failure.
Exits non-zero if any check FAILs. WARN is advisory and never fails the run.

Makes real outbound requests to allow-listed hosts (archive.ubuntu.com, pypi.org)
but never spends a real credential: the injection path is checked structurally
(SDS secret freshness) and via a wrong-Authorization request that gate.lua
rejects locally with 403.

The VM-path checks probe the host-only adapter the forwarder listens on.
-AdapterAlias defaults to the VMware host-only NIC; on a Hyper-V host pass the
Internal-switch adapter instead, matching host-allow-vm-inbound.ps1, e.g.:

    ... -File .configamatron\proxy\verify-proxy.ps1 -AdapterAlias "vEthernet (configamatron-internal)"
#>
[CmdletBinding()]
param(
    [string]$EnvDir = (Get-Location).Path,
    [string]$AdapterAlias = 'VMware Network Adapter VMnet1'
)

$ErrorActionPreference = 'Stop'

$script:pass = 0
$script:fail = 0
$script:warn = 0

function Write-Section($name) { Write-Host ''; Write-Host "== $name ==" }
function Add-Pass($msg) {
    $script:pass++; Write-Host "  PASS  $msg" -ForegroundColor Green
}
function Add-Fail($msg, $detail) {
    $script:fail++
    if ($detail) { Write-Host "  FAIL  $msg -- $detail" -ForegroundColor Red }
    else { Write-Host "  FAIL  $msg" -ForegroundColor Red }
}
function Add-Warn($msg, $detail) {
    $script:warn++
    if ($detail) { Write-Host "  WARN  $msg -- $detail" -ForegroundColor Yellow }
    else { Write-Host "  WARN  $msg" -ForegroundColor Yellow }
}

# Run curl.exe and return the observed HTTP status code plus the process exit code.
function Invoke-CurlCode {
    param([Parameter(Mandatory)][string[]]$CurlArgs)
    $code = & curl.exe -s -o NUL -w '%{http_code}' @CurlArgs 2>$null
    return [pscustomobject]@{ Code = "$code".Trim(); Exit = $LASTEXITCODE }
}

$proxyDir = Join-Path $EnvDir '.configamatron\proxy'
$caCert   = Join-Path $proxyDir 'ca\cert.pem'
$sdsFile  = Join-Path $proxyDir 'secrets\sds-secret.yaml'

Write-Section 'Environment & Docker'

if (-not (Test-Path $proxyDir)) {
    Add-Fail "environment present" "no proxy dir at $proxyDir -- run this from the environment directory"
    Write-Host ''
    Write-Host "$($script:pass) passed, $($script:fail) failed, $($script:warn) warnings"
    exit 1
}
Add-Pass "environment present ($proxyDir)"

foreach ($f in @('docker-compose.yml', 'envoy.yaml', 'ca\cert.pem')) {
    $p = Join-Path $proxyDir $f
    if (Test-Path $p) { Add-Pass "config file $f present" }
    else { Add-Fail "config file $f present" "missing $p" }
}

& docker info *> $null
if ($LASTEXITCODE -eq 0) { Add-Pass 'docker daemon reachable' }
else { Add-Fail 'docker daemon reachable' 'docker info exited non-zero -- is Docker running?' }

$envoy = & docker ps `
    --filter 'label=com.docker.compose.project=configamatron' `
    --format '{{.Names}} {{.Status}}' 2>$null | Where-Object { $_ -match 'envoy' }
if ($envoy -match 'Up') { Add-Pass "envoy container running ($(($envoy | Select-Object -First 1).Trim()))" }
else { Add-Fail 'envoy container running' "no running configamatron envoy container ('$envoy') -- run 'configamatron run-proxy'" }

foreach ($port in 80, 443) {
    $listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listen) { Add-Pass "host port $port listening" }
    else { Add-Fail "host port $port listening" 'no listener found' }
}

Write-Section 'Credential secret (structural, no API call)'

$hostCred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
if (-not (Test-Path $sdsFile)) {
    Add-Fail 'SDS secret present' "missing $sdsFile -- run 'configamatron run-proxy'"
}
elseif (-not (Test-Path $hostCred)) {
    Add-Warn 'SDS secret freshness' "cannot compare: no host credential at $hostCred"
}
else {
    try {
        $token = (Get-Content $hostCred -Raw | ConvertFrom-Json).claudeAiOauth.accessToken
        $sds = Get-Content $sdsFile -Raw
        if ($token -and $sds.Contains("Bearer $token")) {
            Add-Pass 'SDS secret matches current host credential'
        }
        else {
            Add-Fail 'SDS secret matches current host credential' 'token drift -- run-proxy is serving a stale token; restart it'
        }
    }
    catch {
        Add-Fail 'SDS secret freshness' "could not compare tokens: $($_.Exception.Message)"
    }
}

Write-Section 'Live proxy behavior'

$allow80 = Invoke-CurlCode @('--resolve', 'archive.ubuntu.com:80:127.0.0.1', '--max-time', '20', 'http://archive.ubuntu.com/')
if ($allow80.Exit -eq 0 -and [int]($allow80.Code) -lt 400) { Add-Pass "allow-listed :80 archive.ubuntu.com -> $($allow80.Code)" }
else { Add-Fail 'allow-listed :80 archive.ubuntu.com' "code=$($allow80.Code) curlExit=$($allow80.Exit)" }

$block80 = Invoke-CurlCode @('--resolve', 'not-allow-listed.example.com:80:127.0.0.1', '--max-time', '20', 'http://not-allow-listed.example.com/')
if ($block80.Code -eq '403') { Add-Pass 'blocked :80 -> 403 (default deny)' }
else { Add-Fail 'blocked :80 default deny' "expected 403, got code=$($block80.Code) curlExit=$($block80.Exit)" }

$allow443 = Invoke-CurlCode @('--resolve', 'pypi.org:443:127.0.0.1', '--max-time', '30', 'https://pypi.org/simple/')
if ($allow443.Exit -eq 0 -and [int]($allow443.Code) -lt 400) { Add-Pass "allow-listed passthrough :443 pypi.org -> $($allow443.Code)" }
else { Add-Fail 'allow-listed passthrough :443 pypi.org' "code=$($allow443.Code) curlExit=$($allow443.Exit)" }

$block443 = Invoke-CurlCode @('--resolve', 'blocked.example.com:443:127.0.0.1', '--max-time', '20', 'https://blocked.example.com/')
if ($block443.Exit -ne 0) { Add-Pass "blocked :443 connection dropped (curlExit=$($block443.Exit))" }
else { Add-Fail 'blocked :443 connection dropped' "expected a connection failure, but curl succeeded (code=$($block443.Code))" }

# --ssl-no-revoke: our leaf has no CRL/OCSP endpoint, so schannel's default
# revocation check fails closed (curl error 60) even though the chain is valid.
$gate = Invoke-CurlCode @('--ssl-no-revoke', '--cacert', $caCert, '--resolve', 'api.anthropic.com:443:127.0.0.1', '-H', 'Authorization: Bearer not-the-placeholder', '--max-time', '20', 'https://api.anthropic.com/')
if ($gate.Code -eq '403') { Add-Pass 'credential gate: wrong Authorization -> 403 (rejected locally, no token spent)' }
else { Add-Fail 'credential gate wrong-auth' "expected 403 from gate.lua, got code=$($gate.Code) curlExit=$($gate.Exit)" }

Write-Section 'VM-path (forwarder -> loopback)'

$vmIpCfg = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias -ErrorAction SilentlyContinue
$vmIp = ($vmIpCfg.IPv4Address | Select-Object -First 1).IPAddress
if (-not $vmIp) {
    Add-Warn 'VM-path checks' "no IPv4 on '$AdapterAlias' -- skipping (is the host-only adapter up?)"
}
else {
    foreach ($port in 80, 443) {
        $listen = Get-NetTCPConnection -LocalAddress $vmIp -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($listen) { Add-Pass "forwarder listening on ${vmIp}:$port" }
        else { Add-Fail "forwarder listening on ${vmIp}:$port" "no listener -- is 'configamatron run-proxy' running?" }
    }

    $fwd80 = Invoke-CurlCode @('--resolve', "archive.ubuntu.com:80:$vmIp", '--max-time', '20', 'http://archive.ubuntu.com/')
    if ($fwd80.Exit -eq 0 -and [int]($fwd80.Code) -lt 400) { Add-Pass "allow-listed :80 via ${vmIp} -> $($fwd80.Code)" }
    else { Add-Fail "allow-listed :80 via ${vmIp}" "code=$($fwd80.Code) curlExit=$($fwd80.Exit)" }

    $fwdGate = Invoke-CurlCode @('--ssl-no-revoke', '--cacert', $caCert, '--resolve', "api.anthropic.com:443:$vmIp", '-H', 'Authorization: Bearer not-the-placeholder', '--max-time', '20', 'https://api.anthropic.com/')
    if ($fwdGate.Code -eq '403') { Add-Pass "credential gate via ${vmIp} -> 403" }
    else { Add-Fail "credential gate via ${vmIp}" "expected 403, got code=$($fwdGate.Code) curlExit=$($fwdGate.Exit)" }
}

Write-Section 'VM reachability'

$rule = Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy (VM inbound)' -ErrorAction SilentlyContinue
if ($rule) { Add-Pass 'host-only inbound firewall rule present' }
else { Add-Warn 'host-only inbound firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin) once the VM is host-only" }

$cfg = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias -ErrorAction SilentlyContinue
$hostIp = ($cfg.IPv4Address | Select-Object -First 1).IPAddress
if ($hostIp) { Add-Pass "$AdapterAlias host IP: $hostIp (use as <host-ip> in VM setup)" }
else { Add-Warn 'host-only adapter IP' "no IPv4 on '$AdapterAlias' -- is the host-only adapter up?" }

Write-Host ''
Write-Host "$($script:pass) passed, $($script:fail) failed, $($script:warn) warnings"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
