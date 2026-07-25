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

It also establishes a program-scoped rule for the node.exe that hosts
run-proxy. Without one, the first run-proxy start on an Internal switch
raises Windows' "allow node.exe on public networks?" dialog - an Internal
switch has no gateway, so Windows can never identify it as anything but
Public - and writes a "Query User{GUID}<path>" rule from whatever gets
clicked. Both answers are wrong: Allow grants any port on any local
address and masks whether the four rules above are present at all (this
is what happened at the 2026-07-23 Windows checkpoint), while dismissing
it writes a Block of the same breadth that silently overrides them, since
Windows evaluates Block before Allow. Pre-empting the dialog is what makes
the environment deterministic; deleting the offending rule after the fact
just buys another coin flip on the next start.

The node path is discovered rather than assumed - see Resolve-RunProxyNode.
Pass -NodePath to override.

Safe to re-run: replaces any existing rules with the same names.
#>
[CmdletBinding()]
param(
    [string]$AdapterAlias = "vEthernet (configamatron-internal)",
    [string]$NatAdapterAlias = "vEthernet (Default Switch)",
    [string]$NodePath
)

$ErrorActionPreference = "Stop"

# Windows matches program rules on the image path of the listening process, so
# this has to be the exact node.exe that will host run-proxy - not "a" node, and
# not an assumed install location. Ordered most to least authoritative.
function Resolve-RunProxyNode {
    # 1. run-proxy is already running, so the OS can be asked directly.
    $running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'run-proxy' } |
        Select-Object -First 1
    if ($running -and $running.ExecutablePath) {
        return [pscustomobject]@{ Path = $running.ExecutablePath; Source = "the running run-proxy process (pid $($running.ProcessId))" }
    }

    # 2. Mirror how the configamatron launcher itself picks node: a sibling
    #    node.exe next to the shim, else PATH. Reading the launcher's own
    #    resolution order beats guessing at a package manager's layout.
    $shim = Get-Command configamatron -ErrorAction SilentlyContinue
    if ($shim -and $shim.Source) {
        $sibling = Join-Path (Split-Path $shim.Source -Parent) "node.exe"
        if (Test-Path $sibling) {
            return [pscustomobject]@{ Path = (Resolve-Path $sibling).Path; Source = "the node.exe beside $($shim.Source)" }
        }
    }

    # 3. The shim's own fallback.
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node -and $node.Source) {
        return [pscustomobject]@{ Path = $node.Source; Source = "'node' on PATH" }
    }

    return $null
}

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

$nodeRuleName = "Configamatron run-proxy node (VM inbound)"
Get-NetFirewallRule -DisplayName $nodeRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

$nodeInfo = if ($NodePath) {
    if (-not (Test-Path $NodePath)) { throw "-NodePath '$NodePath' does not exist." }
    [pscustomobject]@{ Path = (Resolve-Path $NodePath).Path; Source = "-NodePath" }
} else {
    Resolve-RunProxyNode
}

if ($nodeInfo) {
    # Clear any prompt-generated rule for this same binary first. A Block one
    # would override every rule created above; an Allow one would hide their
    # absence. Matched on the resolved path rather than on "any node.exe", so
    # rules the user allowed for unrelated node programs are left alone.
    $stale = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -like "*Query User*" -and $_.Name.EndsWith($nodeInfo.Path, [StringComparison]::OrdinalIgnoreCase)
    }
    foreach ($rule in $stale) {
        Write-Host "Removing prompt-generated $($rule.Action) rule: $($rule.Name)"
    }
    if ($stale) { $stale | Remove-NetFirewallRule }

    New-NetFirewallRule -DisplayName $nodeRuleName -Direction Inbound -Program $nodeInfo.Path `
        -InterfaceAlias $AdapterAlias -Action Allow | Out-Null
    Write-Host "Program rule created for $($nodeInfo.Path)"
    Write-Host "  (discovered from $($nodeInfo.Source))"
} else {
    Write-Warning ("Could not locate the node.exe that hosts run-proxy, so no program-scoped rule was created. " +
        "The port rules above are in place, but the first run-proxy start may raise the Windows firewall dialog, " +
        "and dismissing that dialog writes a Block rule which overrides them. " +
        "Re-run with -NodePath '<path to node.exe>' to pre-empt it.")
}

Write-Host "Firewall rules created, scoped to interface '$AdapterAlias'."
Write-Host "Host IP for this network: $hostIp"
Write-Host "Use this as <host-ip> in:"
Write-Host "  bash vm/vm-setup-persistence.sh $hostIp"
