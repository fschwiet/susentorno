import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir } from './diagnostics';
import type { GuestRole } from './hyperv/imageCache';
import type { WindowsGuestExec } from './windowsGuestExec';

/** Collect each dump independently so one broken command cannot hide the others. */
export async function collectWindowsDiagnostics(
  guest: WindowsGuestExec,
  role: GuestRole,
): Promise<void> {
  const dir = join(artifactsDir, role);
  mkdirSync(dir, { recursive: true });
  const dumps: [string, string][] = [
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
      'environment.txt',
      "[Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS','Machine'); " +
        'git config --global http.sslBackend; net use',
    ],
    [
      'events.txt',
      'Get-WinEvent -LogName System -MaxEvents 100 -ErrorAction SilentlyContinue | ' +
        'Format-Table TimeCreated,Id,LevelDisplayName,Message -AutoSize | Out-String -Width 200',
    ],
  ];
  for (const [filename, script] of dumps) {
    try {
      const { stdout } = await guest.capture(script);
      writeFileSync(join(dir, filename), stdout);
    } catch (error) {
      writeFileSync(join(dir, filename), `diagnostics: dump failed: ${String(error)}\n`);
    }
  }
  console.log(`guest(${role}): diagnostics in ${dir}`);
}
