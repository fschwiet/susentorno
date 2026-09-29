import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PowerShellExec } from '../../src/guestSetup/powerShellExec';
import { PENDING_REBOOT_SCRIPT } from '../../src/guestSetup/windows/guestChecks';
import {
  GUEST_TRUST_BUNDLE_PATH,
  GUEST_TRUST_DIR,
} from '../../src/guestSetup/windows/trustScripts';
import { artifactsDir } from './diagnostics';
import { captureScreenshotFrame } from './hyperv/vmScreenshot';
import type { GuestRole } from './hyperv/imageCache';
import type { WindowsGuestExec } from './windowsGuestExec';

const WINGET_DIAG_DIRECTORY =
  "Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\\LocalState\\DiagOutputDir'";

export interface WindowsDiagnosticsHost {
  exec: PowerShellExec;
  /** Host-side files (each run's saved command log) copied next to the guest dumps. */
  files?: { path: string; name: string }[];
}

/** The dumps taken inside the guest. Each is collected independently. */
export const WINDOWS_GUEST_DUMPS: readonly (readonly [string, string])[] = [
  [
    'network.txt',
    'Get-NetIPConfiguration | Out-String; Get-NetIPAddress -AddressFamily IPv4 | ' +
      'Format-List InterfaceAlias,InterfaceIndex,IPAddress,PrefixOrigin,SuffixOrigin | Out-String; ' +
      'Get-NetRoute -AddressFamily IPv4 | Out-String; ' +
      'Get-DnsClientServerAddress -AddressFamily IPv4 | Out-String',
  ],
  [
    'trust.txt',
    "$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine'); " +
      "$s.Open('ReadOnly'); $s.Certificates | Select-Object Subject,Thumbprint | Out-String; $s.Close()",
  ],
  [
    // The managed manifest and the combined bundle's fingerprints: never PEM content.
    'trust-managed.txt',
    [
      `$dir = '${GUEST_TRUST_DIR}'`,
      "Get-Content -Raw -LiteralPath (Join-Path $dir 'manifest.json') -ErrorAction Continue",
      `$bundle = '${GUEST_TRUST_BUNDLE_PATH}'`,
      'if (Test-Path -LiteralPath $bundle) {',
      "  $pem = [regex]::Matches((Get-Content -Raw -LiteralPath $bundle), '-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----')",
      '  $sha = [System.Security.Cryptography.SHA256]::Create()',
      '  "bundle certificates: $($pem.Count)"',
      '  foreach ($m in $pem) {',
      "    $b64 = ($m.Value -replace '-----[A-Z ]+-----', '') -replace '\\s', ''",
      '    $der = [Convert]::FromBase64String($b64)',
      '    "bundle sha256 " + (($sha.ComputeHash($der) | ForEach-Object { $_.ToString("x2") }) -join "")',
      '  }',
      '} else { "bundle missing: $bundle" }',
    ].join('\n'),
  ],
  [
    'environment.txt',
    "[Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS','Machine'); " +
      'git config --global http.sslBackend; net use; Get-ExecutionPolicy -List | Out-String',
  ],
  [
    // Targets only: never the user or any other credential detail.
    'cmdkey-targets.txt',
    "cmdkey /list | Where-Object { $_ -match '^\\s*Target:' }",
  ],
  ['pending-reboot.txt', PENDING_REBOOT_SCRIPT],
  [
    'winget-logs.txt',
    [
      `$dir = ${WINGET_DIAG_DIRECTORY}`,
      'if (Test-Path -LiteralPath $dir) {',
      '  Get-ChildItem -LiteralPath $dir -File | Sort-Object LastWriteTime | Select-Object -Last 4 | ForEach-Object {',
      '    "===== $($_.Name)"',
      '    Get-Content -LiteralPath $_.FullName -Tail 250',
      '  }',
      '} else { "no WinGet DiagOutputDir at $dir" }',
    ].join('\n'),
  ],
  [
    'events.txt',
    'Get-WinEvent -LogName System -MaxEvents 100 -ErrorAction SilentlyContinue | ' +
      'Format-Table TimeCreated,Id,LevelDisplayName,Message -AutoSize | Out-String -Width 200',
  ],
];

/** Collect each dump independently so one broken command cannot hide the others. */
export async function collectWindowsDiagnostics(
  guest: WindowsGuestExec,
  role: GuestRole,
  host?: WindowsDiagnosticsHost,
): Promise<void> {
  const dir = join(artifactsDir, role);
  mkdirSync(dir, { recursive: true });
  for (const [filename, script] of WINDOWS_GUEST_DUMPS) {
    try {
      const { stdout } = await guest.capture(script);
      writeFileSync(join(dir, filename), stdout);
    } catch (error) {
      writeFileSync(join(dir, filename), `diagnostics: dump failed: ${String(error)}\n`);
    }
  }
  if (host) {
    await captureScreenshotFrame(host.exec, guest.vmName, join(dir, 'screenshots'), 'final-');
    for (const file of host.files ?? []) {
      try {
        copyFileSync(file.path, join(dir, file.name));
      } catch (error) {
        writeFileSync(join(dir, file.name), `diagnostics: copy failed: ${String(error)}\n`);
      }
    }
  }
  console.log(`guest(${role}): diagnostics in ${dir}`);
}
