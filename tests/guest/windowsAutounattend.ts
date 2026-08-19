export const WINDOWS_GUEST_HOSTNAME = 'susentorno-test-win';
/** Must match an image in the supplied ISO; see SUSENTORNO_WINDOWS_ISO's x64/en-us contract. */
export const WINDOWS_IMAGE_NAME = 'Windows 11 Enterprise Evaluation';
export const PROVISIONING_SCRIPT_PATH = 'C:\\Windows\\Setup\\Scripts\\susentorno-provision.ps1';
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
    '$stage = if (Test-Path $stagePath) { (Get-Content $stagePath -Raw).Trim() } else { "update" }',
    'function Set-Stage($value) { Set-Content -LiteralPath $stagePath -Value $value -Encoding ascii }',
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
    '    if ($installResult.RebootRequired) { Set-Stage "update"; Restart-Computer -Force; exit 0 }',
    '    if ($anyFailed) {',
    '      # A failure with no reboot pending would otherwise busy-loop on the',
    '      # same update; reboot to give the Windows Update service a fresh',
    '      # session and retry, rather than treating failure as success.',
    '      Set-Stage "update"; Restart-Computer -Force; exit 0',
    '    }',
    '  }',
    '}',
    '',
    'if ($stage -eq "git") {',
    '  winget install --id Git.Git --exact --silent --accept-source-agreements --accept-package-agreements --source winget',
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
    '  Stop-Computer -Force',
    '}',
    '',
  ].join('\r\n');
}

export interface AutounattendInputs {
  password: string;
  provisioningScript: string;
}

/**
 * Setup finds this on the second DVD drive. Note what is deliberately absent:
 * no Windows Update policy (it would stop the COM search returning anything —
 * the provisioning script applies it after servicing), and no
 * LocalAccountTokenFilterPolicy (it governs network remote administration and
 * would be cargo-culted here; elevation is asserted at runtime instead).
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
          <CommandLine>powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "New-Item -ItemType Directory -Force -Path 'C:\\Windows\\Setup\\Scripts' | Out-Null; [IO.File]::WriteAllText('${PROVISIONING_SCRIPT_PATH}', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(inputs.provisioningScript, 'utf8').toString('base64')}')))"</CommandLine>
          <Description>Write the provisioning script</Description>
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
