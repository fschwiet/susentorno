import { diffAmbientCandidates } from '../../src/guestSetup/ambientTrust';
import { enumerateHostTrustedRoots } from '../../src/guestSetup/hostTrustStore';
import type { PowerShellExec } from '../../src/guestSetup/powerShellExec';
import type { WindowsGuestExec } from './windowsGuestExec';

export class WindowsAmbientTrustError extends Error {}

/**
 * The guest half of ambient trust, which production has only for Ubuntu:
 * propagateAmbientTrust is wired solely into setup-guest-unix, and there is no
 * Windows command to call a Windows arm from. Adding one to src/ would ship a
 * feature with no caller, so this lives in the harness — but the *host* half,
 * where the trust-selection policy lives, is the production enumerator.
 *
 * Why it is needed at all: on a developer host that is itself behind a
 * terminating proxy, a passthrough destination in the inner policy can still be
 * TLS-terminated by the outer one. current-auth-list.txt puts github.com:443
 * under `#pragma github authenticated`, so the git assertion fails without this.
 */
export function buildListGuestRootSha256Script(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')",
    "$store.Open('ReadOnly')",
    '$sha = [System.Security.Cryptography.SHA256]::Create()',
    'foreach ($c in $store.Certificates) { ' +
      '($sha.ComputeHash($c.RawData) | ForEach-Object { $_.ToString("x2") }) -join "" }',
    '$store.Close()',
  ].join('; ');
}

export function parseGuestRootSha256(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[0-9a-f]{64}$/.test(line));
}

/** base64 over the wire: a PEM's own newlines cannot survive nested quoting. */
export function buildImportRootScript(pem: string): string {
  const encoded = Buffer.from(pem, 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$bytes = [Convert]::FromBase64String('${encoded}')`,
    '$text = [Text.Encoding]::UTF8.GetString($bytes)',
    '$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(' +
      '[Text.Encoding]::ASCII.GetBytes($text))',
    "$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')",
    "$store.Open('ReadWrite')",
    '$store.Add($cert)',
    '$store.Close()',
  ].join('; ');
}

/**
 * Diffs rather than bulk-imports. enumerateHostTrustedRoots returns every
 * accepted host root, not the non-public subset, so importing the lot would
 * be both wasteful and misleading about what "ambient" means.
 */
export async function propagateAmbientTrustToWindows(
  exec: PowerShellExec,
  guest: WindowsGuestExec,
  onStep: (message: string) => void = () => {},
): Promise<string[]> {
  onStep('enumerate host trusted roots');
  const { roots } = await enumerateHostTrustedRoots(exec);

  onStep('fingerprint the guest root store');
  const listed = await guest.capture(buildListGuestRootSha256Script());
  if (listed.exitCode !== 0) {
    throw new WindowsAmbientTrustError(
      `windowsAmbientTrust: could not fingerprint the guest root store (exit ${listed.exitCode}): ${listed.stdout}`,
    );
  }
  const guestFingerprints = parseGuestRootSha256(listed.stdout);

  const toInstall = diffAmbientCandidates(roots, guestFingerprints);
  if (toInstall.length === 0) {
    onStep('no ambient interception detected');
    return [];
  }

  const installed: string[] = [];
  for (const root of toInstall) {
    const { exitCode, stdout } = await guest.run(buildImportRootScript(root.pem));
    if (exitCode !== 0) {
      throw new WindowsAmbientTrustError(
        `windowsAmbientTrust: could not import ${root.sha256.slice(0, 16)} (exit ${exitCode}): ${stdout}`,
      );
    }
    installed.push(root.sha256);
  }
  onStep(`trusted ${installed.length} ambient root(s)`);
  return installed;
}
