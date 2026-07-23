#requires -Modules NetSecurity, NetTCPIP
<#
Opens inbound traffic from the VM's Hyper-V Internal-switch adapter:

  TCP 80/443  - Envoy, via run-proxy's gateway
  UDP 53      - run-proxy's DNS responder
  UDP 67      - run-proxy's DHCP server

and prints the host IP to pass to the guest setup scripts.

DNS answering moved back to the host, so the UDP/53 rule is current again.

Scoped by -InterfaceAlias rather than a hardcoded subnet CIDR, since
the Internal switch's subnet is assigned per-machine (e.g.
192.168.67.0/24 on one machine, something else on another) - this rule
keeps working whatever that subnet turns out to be.

Safe to re-run: replaces any existing rules with the same names.
#>
[CmdletBinding()]
param(
    [string]$AdapterAlias = "vEthernet (configamatron-internal)",
    [string]$NatAdapterAlias = "vEthernet (Default Switch)"
)

$ErrorActionPreference = "Stop"

$config = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias
$hostIp = ($config.IPv4Address | Select-Object -First 1).IPAddress

if (-not $hostIp) {
    throw "No IPv4 address on adapter '$AdapterAlias'. Confirm the VM is on the Internal switch and this is the right adapter (Get-NetIPConfiguration lists all adapters)."
}

$tcpRuleName = "Envoy Sandbox Proxy (VM inbound)"
$dnsRuleName = "Envoy Sandbox Proxy DNS stub (VM inbound)"
$dhcpRuleName = "Envoy Sandbox Proxy DHCP (VM inbound)"

Get-NetFirewallRule -DisplayName $tcpRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName $dnsRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName $dhcpRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule -DisplayName $tcpRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $dnsRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 53 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $dhcpRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 67 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

$smbRuleName = "Configamatron share (VM inbound)"
Get-NetFirewallRule -DisplayName $smbRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $smbRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 445 -InterfaceAlias $AdapterAlias, $NatAdapterAlias -Action Allow | Out-Null

Write-Host "Firewall rules created, scoped to interface '$AdapterAlias'."
Write-Host "Host IP for this network: $hostIp"
Write-Host "Use this as <host-ip> in:"
Write-Host "  bash vm/vm-setup-persistence.sh $hostIp"
