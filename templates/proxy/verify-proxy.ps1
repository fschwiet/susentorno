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

The VM-path checks probe the Internal-switch adapter the forwarder listens on.
-AdapterAlias defaults to the Hyper-V Internal-switch NIC "vEthernet
(configamatron-internal)"; pass a different alias if your switch is named
differently, matching host-allow-vm-inbound.ps1, e.g.:

    ... -File .configamatron\proxy\verify-proxy.ps1 -AdapterAlias "vEthernet (my-switch)"
#>
[CmdletBinding()]
param(
    [string]$EnvDir = (Get-Location).Path,
    [string]$AdapterAlias = 'vEthernet (configamatron-internal)'
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

# gate.lua substitutes the real token only for an exact placeholder match; any other
# Authorization passes through to the upstream unmodified (it no longer 403s an
# unexpected credential -- see docs/investigations/2026-07-22-remote-control-session-
# token-rejected-by-claude-gate.md). So a foreign credential must reach the upstream
# and be REJECTED there. /v1/models rather than "/", because "/" answers 404 whatever
# the credential and so cannot distinguish rejection from injection. >=400 rather than
# a specific code stays robust to upstream changes; a 2xx is the outcome that must
# never happen, meaning the real token was substituted for a foreign one.
#
# --ssl-no-revoke: our leaf has no CRL/OCSP endpoint, so schannel's default
# revocation check fails closed (curl error 60) even though the chain is valid.
$gate = Invoke-CurlCode @('--ssl-no-revoke', '--cacert', $caCert, '--resolve', 'api.anthropic.com:443:127.0.0.1', '-H', 'Authorization: Bearer not-the-placeholder', '-H', 'anthropic-version: 2023-06-01', '--max-time', '20', 'https://api.anthropic.com/v1/models')
if ($gate.Exit -ne 0 -or -not $gate.Code -or $gate.Code -eq '000') { Add-Fail 'credential gate wrong-auth' "no response from upstream (code=$($gate.Code) curlExit=$($gate.Exit))" }
elseif ([int]$gate.Code -lt 400) { Add-Fail 'credential gate wrong-auth' "got $($gate.Code) -- a foreign credential was upgraded; the real token must never be substituted" }
else { Add-Pass "credential gate: foreign credential passed through and rejected upstream ($($gate.Code))" }

Write-Section 'VM-path (forwarder -> loopback)'

$vmIpCfg = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias -ErrorAction SilentlyContinue
$vmIp = ($vmIpCfg.IPv4Address | Select-Object -First 1).IPAddress
if (-not $vmIp) {
    Add-Warn 'VM-path checks' "no IPv4 on '$AdapterAlias' -- skipping (is the Internal-switch adapter up?)"
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

    # Same contract as the loopback gate check above: a foreign credential is passed
    # through and must be rejected by the upstream, never upgraded to the real token.
    $fwdGate = Invoke-CurlCode @('--ssl-no-revoke', '--cacert', $caCert, '--resolve', "api.anthropic.com:443:$vmIp", '-H', 'Authorization: Bearer not-the-placeholder', '-H', 'anthropic-version: 2023-06-01', '--max-time', '20', 'https://api.anthropic.com/v1/models')
    if ($fwdGate.Exit -ne 0 -or -not $fwdGate.Code -or $fwdGate.Code -eq '000') { Add-Fail "credential gate via ${vmIp}" "no response from upstream (code=$($fwdGate.Code) curlExit=$($fwdGate.Exit))" }
    elseif ([int]$fwdGate.Code -lt 400) { Add-Fail "credential gate via ${vmIp}" "got $($fwdGate.Code) -- a foreign credential was upgraded; the real token must never be substituted" }
    else { Add-Pass "credential gate via ${vmIp}: rejected upstream ($($fwdGate.Code))" }
}

Write-Section 'Host network model'

# A weak-host flip is a real confinement break, not advisory: it lets the
# guest reach the host's other IPs on the allowed ports (see
# docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md).
$netIf = Get-NetIPInterface -InterfaceAlias $AdapterAlias -AddressFamily IPv4 -ErrorAction SilentlyContinue
if (-not $netIf) {
    Add-Warn 'host network model checked' "no IPv4 interface named '$AdapterAlias' -- is the Internal-switch adapter up?"
} else {
    if ($netIf.Forwarding.ToString() -eq 'Disabled') { Add-Pass "IP forwarding disabled on $AdapterAlias" }
    else { Add-Fail "IP forwarding disabled on $AdapterAlias" "Forwarding=$($netIf.Forwarding) -- a guest could be routed to the host's other networks" }

    if ($netIf.WeakHostReceive.ToString() -eq 'Disabled') { Add-Pass "strong-host model (WeakHostReceive disabled) on $AdapterAlias" }
    else { Add-Fail "strong-host model (WeakHostReceive disabled) on $AdapterAlias" "WeakHostReceive=$($netIf.WeakHostReceive) -- guest could reach the host's other IPs on the allowed ports" }
}

Write-Section 'Stale prompt-generated rules'

# Scans for ANY node.exe, not just a specific path, so a rule left behind by a
# different (e.g. repo-local dev) node.exe that once hosted run-proxy is also
# caught -- reported, not deleted, since a match might be legitimate for an
# unrelated program.
$staleNodeRules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like "*Query User*" -and $_.Name.EndsWith('node.exe', [StringComparison]::OrdinalIgnoreCase)
})
if ($staleNodeRules.Count -eq 0) {
    Add-Pass 'no stale Query User rule for any node.exe'
} else {
    foreach ($rule in $staleNodeRules) {
        Add-Fail 'no stale Query User rule for any node.exe' "$($rule.Action) rule '$($rule.Name)' -- rerun host-allow-vm-inbound.ps1, or investigate why Windows re-prompted"
    }
}

Write-Section 'VM reachability'

$rule = Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy (VM inbound)' -ErrorAction SilentlyContinue
if ($rule) { Add-Pass 'Internal-switch inbound firewall rule present' }
else { Add-Warn 'Internal-switch inbound firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin) once the VM is on the Internal switch" }
$dnsRule = Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy DNS stub (VM inbound)' -ErrorAction SilentlyContinue
if ($dnsRule) { Add-Pass 'Internal-switch inbound DNS firewall rule present' }
else { Add-Warn 'Internal-switch inbound DNS firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin)" }
$dhcpRule = Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy DHCP (VM inbound)' -ErrorAction SilentlyContinue
if ($dhcpRule) { Add-Pass 'Internal-switch inbound DHCP firewall rule present' }
else { Add-Warn 'Internal-switch inbound DHCP firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin)" }

$cfg = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias -ErrorAction SilentlyContinue
$hostIp = ($cfg.IPv4Address | Select-Object -First 1).IPAddress
if ($hostIp) { Add-Pass "$AdapterAlias host IP: $hostIp (use as <host-ip> in VM setup)" }
else { Add-Warn 'Internal-switch adapter IP' "no IPv4 on '$AdapterAlias' -- is the Internal-switch adapter up?" }
if ($hostIp) {
    $dnsListener = Get-NetUDPEndpoint -LocalAddress $hostIp -LocalPort 53 -ErrorAction SilentlyContinue
    if ($dnsListener) { Add-Pass "DNS responder listening on ${hostIp}:53" }
    else { Add-Fail "DNS responder listening on ${hostIp}:53" "not found -- is run-proxy running? guests have no other resolver" }
    $dhcpListener = Get-NetUDPEndpoint -LocalAddress $hostIp -LocalPort 67 -ErrorAction SilentlyContinue
    if ($dhcpListener) { Add-Pass "DHCP server listening on ${hostIp}:67" }
    else { Add-Fail "DHCP server listening on ${hostIp}:67" "not found -- is run-proxy running? guests cannot get an address" }
}

Write-Host ''
Write-Host "$($script:pass) passed, $($script:fail) failed, $($script:warn) warnings"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
