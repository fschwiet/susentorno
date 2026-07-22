#Requires -RunAsAdministrator
param([Parameter(Mandatory = $true)][string]$HostIp, [string]$CertPath)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$shareRoot = Split-Path -Parent $scriptDir
if (-not $CertPath) { $CertPath = Join-Path $shareRoot 'cert.pem' }

if (-not (Test-Path $CertPath)) {
  Write-Error "05-configure-network: $CertPath not found. Run 'configamatron generate-ca' on the host first."
  exit 1
}

# --- Trust the proxy CA ---

# 1) Windows machine Root store — covers .NET (uses the store) and schannel.
certutil -f -addstore Root $CertPath | Out-Null

# 2) Node tools (claude/codex) ignore the Windows store, so point NODE_EXTRA_CA_CERTS
#    at a stable copy. Machine scope so every new shell inherits it.
$caDir = 'C:\ProgramData\configamatron'
New-Item -ItemType Directory -Force -Path $caDir | Out-Null
$caStable = Join-Path $caDir 'proxy-ca.pem'
Copy-Item -Force $CertPath $caStable
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $caStable, 'Machine')

# 3) Git for Windows: use the Windows store (schannel).
git config --global http.sslBackend schannel

Write-Host "05-configure-network: imported $CertPath into LocalMachine\Root; NODE_EXTRA_CA_CERTS=$caStable; git sslBackend=schannel"

# --- DNS responder ---

# Stop any already-running responder first: Windows locks a running exe, so a
# rerun's `dotnet publish` below would fail to overwrite it otherwise.
$taskName = 'ConfigamatronDnsResponder'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Process -Name $taskName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
}

# 1) Publish the shipped C# catch-all DNS responder to a stable location. Copy the
#    source to a writable build dir first (the share is read-only for dotnet's obj/).
$installDir = 'C:\ProgramData\configamatron\dns-responder'
$buildDir = 'C:\ProgramData\configamatron\dns-responder-build'
if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path (Join-Path $scriptDir 'dns-responder') '*') -Destination $buildDir
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

# 4) Point every up adapter's DNS at the local responder; suppress DHCP DNS.
$ifaces = Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq 'Up' } |
  Select-Object -ExpandProperty InterfaceAlias
if (-not $ifaces) { Write-Error "05-configure-network: could not determine the VM's network interface."; exit 1 }
foreach ($iface in $ifaces) {
  Set-DnsClientServerAddress -InterfaceAlias $iface -ServerAddresses '127.0.0.1'
}
Clear-DnsClientCache

Write-Host "05-configure-network: CA trusted; DNS responder installed (-> $HostIp), scheduled at startup; DNS set to 127.0.0.1 on: $($ifaces -join ', ')"
