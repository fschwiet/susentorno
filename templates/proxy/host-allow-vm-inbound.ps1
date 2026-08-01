#requires -Modules NetSecurity, NetTCPIP
<#
Opens inbound traffic from the VM's Hyper-V Internal-switch adapter:

  TCP 80/443  - Envoy, via run-proxy's gateway
  UDP 53      - run-proxy's DNS responder
  UDP 67      - run-proxy's DHCP server
  TCP 445     - the susentorno-share SMB share (Internal-switch and NAT)

and prints the host IP to pass to the guest setup scripts.

Every rule except DHCP (:67 - see below) is scoped by -LocalAddress as well as
-InterfaceAlias. An -InterfaceAlias-only rule permits a packet to *any* local
address on that port, relying entirely on Windows' strong-host model (and
disabled IP forwarding) to keep it confined to this adapter's own address.
-LocalAddress makes that confinement hold even if the host model is ever
weakened - see
docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md.

UDP 67 (DHCP) stays interface-scoped only: a client with no address broadcasts
DISCOVER from 0.0.0.0 to 255.255.255.255, not the host's unicast IP, so a
-LocalAddress condition would silently break DHCP.

The SMB rule spans two adapters (this one and the NAT/Default-Switch one), so
it's two separate rules under the same DisplayName, each with its own
-InterfaceAlias/-LocalAddress pair - a single rule listing both interfaces and
both addresses would let a packet arriving on either interface match either
address, which is not the same guarantee.

It also establishes three program-scoped rules for a dedicated copy of
node.exe that run-proxy relaunches itself through on Windows
(src/runProxy/relaunchViaDedicatedNode.ts), rather than the shared system
node.exe. Without these, the first run-proxy start on an Internal switch
raises Windows' "allow node.exe on public networks?" dialog - an Internal
switch has no gateway, so Windows can never identify it as anything but
Public - and writes a "Query User{GUID}<path>" rule from whatever gets
clicked. Both answers are wrong: Allow grants any port on any local address
and masks whether the four rules above are present at all (this is what
happened at the 2026-07-23 Windows checkpoint), while dismissing it writes a
Block of the same breadth that silently overrides them, since Windows
evaluates Block before Allow. Pre-empting the dialog is what makes the
environment deterministic. Three rules, not one, because -LocalPort can't mix
TCP and UDP under one -Protocol - this mirrors the plain port rules' own
three-way split.

The dedicated node.exe lives at a fixed, host-wide path
(%USERPROFILE%\.susentorno-host\run-proxy-node.exe) that run-proxy creates
on its first forwarded start. The path is a known constant, not discovered -
New-NetFirewallRule -Program does not require the file to exist yet, so this
script can run before that first start.

Safe to re-run: replaces any existing rules with the same names.
#>
[CmdletBinding()]
param(
    [string]$AdapterAlias = "vEthernet (susentorno-internal)",
    [string]$NatAdapterAlias = "vEthernet (Default Switch)"
)

$ErrorActionPreference = "Stop"

# Resolve and validate every address this script needs up front, before any
# existing rule is removed, so a resolution failure aborts cleanly rather than
# leaving rules deleted and not yet replaced.
$config = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias
$hostIp = ($config.IPv4Address | Select-Object -First 1).IPAddress
if (-not $hostIp) {
    throw "No IPv4 address on adapter '$AdapterAlias'. Confirm the VM is on the Internal switch and this is the right adapter (Get-NetIPConfiguration lists all adapters)."
}

$natConfig = Get-NetIPConfiguration -InterfaceAlias $NatAdapterAlias
$natHostIp = ($natConfig.IPv4Address | Select-Object -First 1).IPAddress
if (-not $natHostIp) {
    throw "No IPv4 address on adapter '$NatAdapterAlias'. The SMB share rule needs this adapter's address; pass -NatAdapterAlias if your NAT switch is named differently."
}

$nodePath = Join-Path $env:USERPROFILE ".susentorno-host\run-proxy-node.exe"

$tcpRuleName = "susentorno Envoy Proxy (VM inbound)"
$dnsRuleName = "susentorno DNS stub (VM inbound)"
$dhcpRuleName = "susentorno DHCP (VM inbound)"
$smbRuleName = "susentorno share (VM inbound)"
$nodeRuleName = "susentorno run-proxy node (VM inbound)"

foreach ($name in @($tcpRuleName, $dnsRuleName, $dhcpRuleName, $smbRuleName, $nodeRuleName)) {
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

# Clear any prompt-generated rule for the dedicated node.exe too, before
# recreating its Allow rules below. A Block one would override every rule
# created here; an Allow one would hide their absence.
$stale = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like "*Query User*" -and $_.Name.EndsWith($nodePath, [StringComparison]::OrdinalIgnoreCase)
}
foreach ($rule in $stale) {
    Write-Host "Removing prompt-generated $($rule.Action) rule: $($rule.Name)"
}
if ($stale) { $stale | Remove-NetFirewallRule }

New-NetFirewallRule -DisplayName $tcpRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $dnsRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 53 -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $dhcpRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 67 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $smbRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 445 -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $smbRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 445 -InterfaceAlias $NatAdapterAlias -LocalAddress $natHostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $nodeRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -Program $nodePath -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $nodeRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 53 -Program $nodePath -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $nodeRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 67 -Program $nodePath -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

Write-Host "Firewall rules created, scoped to interface '$AdapterAlias'."
Write-Host "Host IP for this network: $hostIp"
Write-Host "Program rules created for $nodePath"
