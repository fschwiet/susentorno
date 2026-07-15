#Requires -RunAsAdministrator
param([Parameter(Mandatory = $true)][string]$HostIp)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Stop any already-running responder first: Windows locks a running exe, so a
# rerun's `dotnet publish` below would fail to overwrite it otherwise. Safe on
# a first-ever run, where the task doesn't exist yet.
$taskName = 'ConfigamatronDnsResponder'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Process -Name $taskName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
}

# 1) Publish the shipped C# catch-all DNS responder to a stable location.
#    dotnet publish writes obj/ intermediates into the *source* project dir, but this
#    script runs from the read-only VMware share. Copy the source to a writable build
#    dir first and publish from there, so nothing writes back to the share.
$installDir = 'C:\ProgramData\configamatron\dns-responder'
$buildDir = 'C:\ProgramData\configamatron\dns-responder-build'
if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path (Join-Path $scriptDir 'dns-responder') '*') -Destination $buildDir
# Defense in depth: drop any bin/obj that slipped onto the share (initEnv filters these).
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `
  (Join-Path $buildDir 'bin'), (Join-Path $buildDir 'obj')
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
dotnet publish $buildDir -c Release -o $installDir

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
