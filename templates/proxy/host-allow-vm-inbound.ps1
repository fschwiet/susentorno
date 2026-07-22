#requires -Modules NetSecurity, NetTCPIP
<#
Opens inbound TCP 80/443 (Envoy) from the VM's Hyper-V Internal-switch adapter,
and prints the host IP to pass to vm/vm-setup-persistence.sh.

Also removes the stale UDP/53 DNS-stub firewall rule created by versions of
this script before DNS answering moved into the VM (see
docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md) - safe to re-run
even if that rule was never created on this machine.

Scoped by -InterfaceAlias rather than a hardcoded subnet CIDR, since
the Internal switch's subnet is assigned per-machine (e.g.
192.168.67.0/24 on one machine, something else on another) - this rule
keeps working whatever that subnet turns out to be.

Safe to re-run: replaces any existing rules with the same names.
#>
[CmdletBinding()]
param(
    [string]$AdapterAlias = "vEthernet (configamatron-internal)"
)

$ErrorActionPreference = "Stop"

$config = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias
$hostIp = ($config.IPv4Address | Select-Object -First 1).IPAddress

if (-not $hostIp) {
    throw "No IPv4 address on adapter '$AdapterAlias'. Confirm the VM is on the Internal switch and this is the right adapter (Get-NetIPConfiguration lists all adapters)."
}

$tcpRuleName = "Envoy Sandbox Proxy (VM inbound)"
$staleDnsRuleName = "Envoy Sandbox Proxy DNS stub (VM inbound)"

Get-NetFirewallRule -DisplayName $tcpRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName $staleDnsRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule -DisplayName $tcpRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

Write-Host "Firewall rules created, scoped to interface '$AdapterAlias'."
Write-Host "Host IP for this network: $hostIp"
Write-Host "Use this as <host-ip> in:"
Write-Host "  bash vm/vm-setup-persistence.sh $hostIp"
