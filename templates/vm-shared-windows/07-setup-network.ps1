#Requires -RunAsAdministrator
param([Parameter(Mandatory = $true)][string]$HostIp)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1) Publish the shipped C# catch-all DNS responder to a stable location.
$installDir = 'C:\ProgramData\configamatron\dns-responder'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
dotnet publish (Join-Path $scriptDir 'dns-responder') -c Release -o $installDir

# 2) Write the host IP where the responder reads it (analog of dnsmasq-stub.conf).
Set-Content -Path (Join-Path $installDir 'responder-config.txt') -Value $HostIp -NoNewline

# 3) Register a startup Scheduled Task: runs at boot as SYSTEM, restarts on failure.
$exe = Join-Path $installDir 'ConfigamatronDnsResponder.exe'
$action = New-ScheduledTaskAction -Execute $exe
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'ConfigamatronDnsResponder' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'ConfigamatronDnsResponder'

# 4) Point the active adapter's DNS at the local responder; suppress DHCP DNS.
#    Prefer the default-gateway interface; fall back to the first up physical NIC.
$iface = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).InterfaceAlias
if (-not $iface) {
  $iface = (Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -First 1).Name
}
if (-not $iface) { Write-Error "07-setup-network: could not determine the VM's network interface."; exit 1 }
Set-DnsClientServerAddress -InterfaceAlias $iface -ServerAddresses '127.0.0.1'
Clear-DnsClientCache

Write-Host "07-setup-network: DNS responder installed (-> $HostIp), scheduled at startup; adapter '$iface' DNS set to 127.0.0.1"
