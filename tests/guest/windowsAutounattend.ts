import type { HostTrustedRoot } from '../../src/guestSetup/hostTrustStore';

/** Windows computer names are NetBIOS names, hard-limited to 15 characters. */
export const WINDOWS_GUEST_HOSTNAME = 'susentorno-win';
/** Must match an image in the supplied ISO; see SUSENTORNO_WINDOWS_ISO's x64/en-us contract. */
export const WINDOWS_IMAGE_NAME = 'Windows 11 Enterprise Evaluation';
export const PROVISIONING_SCRIPT_PATH = 'C:\\Windows\\Setup\\Scripts\\susentorno-provision.ps1';
/** Name on the answer-file ISO (SUSENTORNO volume label), alongside Autounattend.xml. */
export const PROVISIONING_SCRIPT_ISO_FILENAME = 'susentorno-provision.ps1';
const STAGE_MARKER_PATH = 'C:\\Windows\\Setup\\Scripts\\susentorno-stage.txt';
const RUN_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE_NAME = 'SusentornoProvision';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Provisioning cannot be a one-shot FirstLogonCommand. Windows Update needs
 * reboots, and a reboot neither resumes an interrupted FirstLogonCommand nor
 * re-runs a consumed RunOnce entry — the process would simply die at the first
 * servicing reboot with Git never installed. Autologon logs the user back in;
 * this Run entry is what actually re-invokes the script, and a stage marker on
 * disk is what tells the resumed run where it left off. The entry removes
 * itself only in the final stage.
 */
export function buildProvisioningScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    `$stagePath = "${STAGE_MARKER_PATH}"`,
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stagePath) | Out-Null',
    // Every prior live build failure was diagnosed by mounting the built
    // disk offline afterward and inferring what must have happened from
    // which files existed -- Windows writes nothing to serial (see
    // windowsGuestExec.ts), so this was otherwise a total black box.
    // -Append survives the reboots servicing requires; Stop-Transcript
    // before every exit point below flushes it, since a forced restart
    // does not reliably let a pending transcript buffer finish writing.
    `Start-Transcript -Path "${STAGE_MARKER_PATH.replace(/\.txt$/, '.log')}" -Append -ErrorAction SilentlyContinue`,
    '$stage = if (Test-Path $stagePath) { (Get-Content $stagePath -Raw).Trim() } else { "update" }',
    'function Set-Stage($value) { Set-Content -LiteralPath $stagePath -Value $value -Encoding ascii }',
    '',
    // The answer-file ISO's SUSENTORNO volume stays mounted as the build
    // VM's second DVD drive for the whole build (see windowsGoldenImage.ts),
    // so any CA certificates shipped alongside this script are still
    // reachable here on every resumed run, not just the first boot. This
    // runs before the stage dispatch below -- unconditionally, on every
    // invocation, not gated behind a single stage -- because both the
    // Windows Update COM search and winget's own download fail TLS
    // validation identically when this host is itself behind a
    // TLS-intercepting proxy the build VM has never seen (confirmed live:
    // WININET_E_CANNOT_CONNECT from the update searcher, "Could not
    // establish trust relationship" from Invoke-WebRequest). Re-importing an
    // already-trusted certificate is a silent no-op, not an error (confirmed
    // against a real LocalMachine\\Root store), so there is no cost to
    // running this every time rather than tracking whether it already ran.
    '$certVolume = Get-Volume -FileSystemLabel "SUSENTORNO" -ErrorAction SilentlyContinue',
    'if ($certVolume) {',
    '  try {',
    '    $certFiles = Get-ChildItem -Path ($certVolume.DriveLetter + ":\\*.pem") -ErrorAction SilentlyContinue',
    '    $certStore = [System.Security.Cryptography.X509Certificates.X509Store]::new("Root", "LocalMachine")',
    '    $certStore.Open("ReadWrite")',
    '    foreach ($certFile in $certFiles) {',
    '      $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certFile.FullName)',
    '      $certStore.Add($cert)',
    '      Write-Host "provision: trusted embedded CA $($cert.Thumbprint) from $($certFile.Name)"',
    '    }',
    '    $certStore.Close()',
    '  } catch {',
    '    Stop-Transcript | Out-Null',
    '    throw "provision: importing an embedded CA certificate failed: $_"',
    '  }',
    '}',
    '',
    'if ($stage -eq "update") {',
    '  $session = New-Object -ComObject Microsoft.Update.Session',
    '  $searcher = $session.CreateUpdateSearcher()',
    '  while ($true) {',
    '    $result = $searcher.Search("IsInstalled=0 and IsHidden=0")',
    '    if ($result.Updates.Count -eq 0) { Set-Stage "git"; $stage = "git"; break }',
    '    $toDownload = New-Object -ComObject Microsoft.Update.UpdateColl',
    '    foreach ($u in $result.Updates) {',
    '      if (-not $u.EulaAccepted) { $u.AcceptEula() }',
    '      $null = $toDownload.Add($u)',
    '    }',
    '    $downloader = $session.CreateUpdateDownloader()',
    '    $downloader.Updates = $toDownload',
    '    $null = $downloader.Download()',
    '    $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl',
    '    foreach ($u in $result.Updates) { if ($u.IsDownloaded) { $null = $toInstall.Add($u) } }',
    '    if ($toInstall.Count -eq 0) { Set-Stage "git"; $stage = "git"; break }',
    '    $installer = $session.CreateUpdateInstaller()',
    '    $installer.Updates = $toInstall',
    '    $installResult = $installer.Install()',
    '    $anyFailed = $false',
    '    for ($i = 0; $i -lt $toInstall.Count; $i++) {',
    '      $updateResult = $installResult.GetUpdateResult($i)',
    '      Write-Host "provision: update $($toInstall.Item($i).Title) resultCode=$($updateResult.ResultCode)"',
    '      if ($updateResult.ResultCode -ne 2 -and $updateResult.ResultCode -ne 3) { $anyFailed = $true }',
    '    }',
    '    Write-Host "provision: install resultCode=$($installResult.ResultCode) reboot=$($installResult.RebootRequired)"',
    '    if ($installResult.RebootRequired) { Set-Stage "update"; Stop-Transcript | Out-Null; Restart-Computer -Force; exit 0 }',
    '    if ($anyFailed) {',
    '      # A failure with no reboot pending would otherwise busy-loop on the',
    '      # same update; reboot to give the Windows Update service a fresh',
    '      # session and retry, rather than treating failure as success.',
    '      Set-Stage "update"; Stop-Transcript | Out-Null; Restart-Computer -Force; exit 0',
    '    }',
    '  }',
    '}',
    '',
    'if ($stage -eq "git") {',
    // Confirmed live by mounting the built (git-less) golden disk offline:
    // Microsoft.DesktopAppInstaller is staged in WindowsApps and its
    // winget.exe execution alias exists in the Administrator profile, but
    // right after an OOBE-skipped first logon the package is not yet
    // *registered* for that profile. An unregistered alias is a phantom
    // stub: invoking it exits 0 and does nothing (no DiagOutputDir was ever
    // created, Program Files\\Git never existed) -- so $LASTEXITCODE alone
    // cannot distinguish success from a no-op. Force registration first.
    '  $gitPath = "$env:ProgramFiles\\Git\\cmd\\git.exe"',
    '  $gitInstalled = $false',
    '  for ($attempt = 1; $attempt -le 10; $attempt++) {',
    '    try {',
    // Registering once before the loop was tried and, per a fourth live
    // rebuild (still no Program Files\Git afterward), did not close the
    // gap either -- registration moves inside the loop so a
    // slow-to-propagate registration gets another chance on the next
    // attempt rather than being tried exactly once.
    '      try {',
    '        Get-AppxPackage -AllUsers -Name Microsoft.DesktopAppInstaller | ForEach-Object {',
    '          Add-AppxPackage -DisableDevelopmentMode -Register "$($_.InstallLocation)\\AppXManifest.xml"',
    '        }',
    '      } catch {',
    '        Write-Host "provision: attempt $attempt Add-AppxPackage DesktopAppInstaller threw: $_"',
    '      }',
    // winget can still be unrecognized as a command this early (confirmed
    // live: its own DiagOutputDir log directory did not exist), which is a
    // terminating PowerShell error under $ErrorActionPreference = 'Stop' --
    // not a native exit code -- so it must be caught, not just checked via
    // $LASTEXITCODE, or a single early attempt kills the whole script.
    '      $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue',
    '      $wingetPath = if ($wingetCmd) { $wingetCmd.Source } else { "$env:LOCALAPPDATA\\Microsoft\\WindowsApps\\winget.exe" }',
    '      & $wingetPath install --id Git.Git --exact --silent --accept-source-agreements --accept-package-agreements --source winget',
    '      Write-Host "provision: winget install Git.Git attempt $attempt exit code $LASTEXITCODE"',
    // The phantom-alias failure mode returns exit 0 having done nothing, so
    // exit code alone is untrustworthy for this package: confirm the
    // binary actually landed before declaring the stage done.
    '      if ($LASTEXITCODE -eq 0 -and (Test-Path $gitPath)) { $gitInstalled = $true; break }',
    '    } catch {',
    '      Write-Host "provision: winget install Git.Git attempt $attempt threw: $_"',
    '    }',
    '    Start-Sleep -Seconds 30',
    '  }',
    '  if (-not $gitInstalled) {',
    // Deliberately does not Set-Stage or clean up: the Run key stays
    // registered and autologon retries the whole "git" stage from scratch on
    // the next logon (LogonCount=10 gives real headroom), rather than
    // silently proceeding to finalize with no git installed -- confirmed
    // live: that is exactly what happened before this check existed.
    '    Stop-Transcript | Out-Null',
    '    throw "provision: winget install Git.Git failed after 10 attempts"',
    '  }',
    '  Set-Stage "finalize"; $stage = "finalize"',
    '}',
    '',
    'if ($stage -eq "finalize") {',
    '  $au = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU"',
    '  New-Item -Path $au -Force | Out-Null',
    '  Set-ItemProperty -Path $au -Name NoAutoUpdate -Value 1 -Type DWord',
    '  $winlogon = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"',
    '  Set-ItemProperty -Path $winlogon -Name AutoAdminLogon -Value "0"',
    '  Remove-ItemProperty -Path $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue',
    `  Remove-ItemProperty -Path "${RUN_KEY}" -Name "${RUN_VALUE_NAME}" -ErrorAction SilentlyContinue`,
    '  Remove-Item -LiteralPath $stagePath -Force -ErrorAction SilentlyContinue',
    '  Stop-Transcript | Out-Null',
    '  Stop-Computer -Force',
    '}',
    '',
  ].join('\r\n');
}

/**
 * One uniquely-named .pem file per root, for merging into the answer-file
 * ISO's extra files alongside the provisioning script. The provisioning
 * script itself discovers these by wildcard (`*.pem` on the SUSENTORNO
 * volume), so the naming only needs to be unique, not agreed with the script
 * — the sha256 is included purely so a stray file is traceable back to a
 * specific host root during debugging.
 */
export function buildCaCertFiles(roots: HostTrustedRoot[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const root of roots) {
    files[`susentorno-ca-${root.sha256}.pem`] = root.pem;
  }
  return files;
}

export interface AutounattendInputs {
  password: string;
}

/**
 * Setup finds this on the second DVD drive. The provisioning script itself is
 * not embedded here — FirstLogonCommands' CommandLine has a ~4096-character
 * limit, and inlining the whole base64-encoded script blew past it, silently
 * invalidating the entire answer file (confirmed live: Setup rejected it with
 * "Value is invalid" for FirstLogonCommands/SynchronousCommand[Order=1] and
 * failed many minutes later with the generic "Windows could not complete the
 * installation"). It instead ships as a separate file on the same ISO
 * (PROVISIONING_SCRIPT_ISO_FILENAME), fetched by a short Copy-Item.
 *
 * Also deliberately absent: no Windows Update policy (it would stop the COM
 * search returning anything — the provisioning script applies it after
 * servicing), and no LocalAccountTokenFilterPolicy (it governs network remote
 * administration and would be cargo-culted here; elevation is asserted at
 * runtime instead).
 */
export function buildAutounattendXml(inputs: AutounattendInputs): string {
  const password = escapeXml(inputs.password);
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassTPMCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>2</Order>
          <Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassSecureBootCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>3</Order>
          <Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassRAMCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>4</Order>
          <Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassCPUCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
      </RunSynchronous>
      <UserData>
        <AcceptEula>true</AcceptEula>
      </UserData>
      <ImageInstall>
        <OSImage>
          <InstallFrom>
            <MetaData wcm:action="add">
              <Key>/IMAGE/NAME</Key>
              <Value>${WINDOWS_IMAGE_NAME}</Value>
            </MetaData>
          </InstallFrom>
          <InstallTo>
            <DiskID>0</DiskID>
            <PartitionID>3</PartitionID>
          </InstallTo>
          <InstallToAvailablePartition>false</InstallToAvailablePartition>
        </OSImage>
      </ImageInstall>
      <DiskConfiguration>
        <WillShowUI>OnError</WillShowUI>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add">
              <Order>1</Order>
              <Type>EFI</Type>
              <Size>260</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>2</Order>
              <Type>MSR</Type>
              <Size>128</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>3</Order>
              <Type>Primary</Type>
              <Extend>true</Extend>
            </CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add">
              <Order>1</Order>
              <PartitionID>1</PartitionID>
              <Format>FAT32</Format>
              <Label>System</Label>
            </ModifyPartition>
            <ModifyPartition wcm:action="add">
              <Order>2</Order>
              <PartitionID>3</PartitionID>
              <Format>NTFS</Format>
              <Letter>C</Letter>
              <Label>Windows</Label>
            </ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
    </component>
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage>
        <UILanguage>en-US</UILanguage>
      </SetupUILanguage>
      <InputLocale>en-US</InputLocale>
      <SystemLocale>en-US</SystemLocale>
      <UILanguage>en-US</UILanguage>
      <UserLocale>en-US</UserLocale>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ComputerName>${WINDOWS_GUEST_HOSTNAME}</ComputerName>
    </component>
    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Path>reg add HKLM\\SYSTEM\\CurrentControlSet\\Control\\BitLocker /v PreventDeviceEncryption /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>2</Order>
          <Path>reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\WindowsStore /v DisableStoreAutoUpdate /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>3</Order>
          <Path>reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection /v AllowTelemetry /t REG_DWORD /d 0 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>4</Order>
          <Path>reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent /v DisableWindowsConsumerFeatures /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <NetworkLocation>Work</NetworkLocation>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <UserAccounts>
        <AdministratorPassword>
          <Value>${password}</Value>
          <PlainText>true</PlainText>
        </AdministratorPassword>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <LogonCount>10</LogonCount>
        <Username>Administrator</Username>
        <Password>
          <Value>${password}</Value>
          <PlainText>true</PlainText>
        </Password>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <CommandLine>powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "New-Item -ItemType Directory -Force -Path 'C:\\Windows\\Setup\\Scripts' | Out-Null; $v = Get-Volume -FileSystemLabel 'SUSENTORNO'; Copy-Item -Path ($v.DriveLetter + ':\\${PROVISIONING_SCRIPT_ISO_FILENAME}') -Destination '${PROVISIONING_SCRIPT_PATH}' -Force"</CommandLine>
          <Description>Copy the provisioning script from the answer-file ISO</Description>
        </SynchronousCommand>
        <SynchronousCommand wcm:action="add">
          <Order>2</Order>
          <CommandLine>reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" /v ${RUN_VALUE_NAME} /t REG_SZ /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${PROVISIONING_SCRIPT_PATH}" /f</CommandLine>
          <Description>Register the resumable provisioner</Description>
        </SynchronousCommand>
        <SynchronousCommand wcm:action="add">
          <Order>3</Order>
          <CommandLine>powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${PROVISIONING_SCRIPT_PATH}</CommandLine>
          <Description>Run provisioning</Description>
        </SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}
