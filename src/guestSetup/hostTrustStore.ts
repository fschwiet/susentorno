import { createHash } from 'node:crypto';
import type { PowerShellExec } from './powerShellExec';

export interface HostTrustedRoot {
  /** Windows' own thumbprint — carried through for logging, not the comparison key. */
  thumbprint: string;
  /** SHA-256 over the certificate's DER encoding — the actual diff/dedup key. */
  sha256: string;
  pem: string;
}

const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
const ANY_EKU_OID = '2.5.29.37.0';

/**
 * Enumeration and filtering both happen here, in PowerShell, rather than
 * pulling every raw store entry back into TypeScript first — the exclusions
 * (Disallowed, EKU) are about which certs the host itself would actually
 * accept, which is a fact about the store, not about the diff this module's
 * caller goes on to compute.
 *
 * Uses [X509Store] directly rather than the Cert:\ PSDrive: verified against
 * a real host that the Cert:\ provider drive is only registered by
 * PowerShell's own console-host startup, not when powershell.exe is spawned
 * as a child process with redirected stdio (execa's case here, regardless of
 * -NoProfile/-NonInteractive or stdio mode) — every Cert:\ reference fails
 * there with "Cannot find drive". [X509Store] has no such dependency, and its
 * certificates still carry the same PowerShell-added .EnhancedKeyUsageList
 * property (confirmed on the same host) and native .Thumbprint/.RawData.
 */
export function buildEnumerateTrustedRootsCommand(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$disallowed = New-Object System.Collections.Generic.List[string]',
    "foreach ($loc in 'LocalMachine','CurrentUser') { try { " +
      "$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('Disallowed', $loc); " +
      "$s.Open('ReadOnly'); foreach ($c in $s.Certificates) { $disallowed.Add($c.Thumbprint) }; " +
      '$s.Close() } catch {} }',
    `$serverAuthOid = '${SERVER_AUTH_OID}'`,
    `$anyEkuOid = '${ANY_EKU_OID}'`,
    '$roots = New-Object System.Collections.Generic.List[object]',
    "foreach ($loc in 'LocalMachine','CurrentUser') { " +
      "$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', $loc); " +
      "$s.Open('ReadOnly'); foreach ($c in $s.Certificates) { $roots.Add($c) }; $s.Close() }",
    '$roots | Where-Object { $disallowed -notcontains $_.Thumbprint -and ' +
      '($_.EnhancedKeyUsageList.Count -eq 0 -or ' +
      '($_.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq $serverAuthOid -or $_.ObjectId -eq $anyEkuOid })) } | ' +
      'ForEach-Object { [PSCustomObject]@{ Thumbprint = $_.Thumbprint; ' +
      'RawDataBase64 = [Convert]::ToBase64String($_.RawData) } } | ' +
      'ConvertTo-Json -Compress',
  ].join('; ');
}

interface RawTrustedRoot {
  Thumbprint?: unknown;
  RawDataBase64?: unknown;
}

function pemFromDer(der: Buffer): string {
  const base64 = der.toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** Individually malformed entries are dropped rather than failing the whole batch; unparseable JSON throws. */
export function parseTrustedRootsResult(stdout: string): HostTrustedRoot[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawTrustedRoot[];
  const roots: HostTrustedRoot[] = [];
  for (const entry of list) {
    if (typeof entry?.Thumbprint !== 'string' || typeof entry?.RawDataBase64 !== 'string') continue;
    const der = Buffer.from(entry.RawDataBase64, 'base64');
    roots.push({
      thumbprint: entry.Thumbprint,
      sha256: createHash('sha256').update(der).digest('hex'),
      pem: pemFromDer(der),
    });
  }
  return roots;
}

export function dedupeBySha256(roots: HostTrustedRoot[]): HostTrustedRoot[] {
  const seen = new Map<string, HostTrustedRoot>();
  for (const root of roots) {
    if (!seen.has(root.sha256)) seen.set(root.sha256, root);
  }
  return [...seen.values()];
}

export class HostTrustStoreError extends Error {}

export async function enumerateHostTrustedRoots(exec: PowerShellExec): Promise<HostTrustedRoot[]> {
  const { exitCode, stdout } = await exec.run(buildEnumerateTrustedRootsCommand());
  if (exitCode !== 0) {
    throw new HostTrustStoreError(
      `hostTrustStore: enumeration exited with code ${exitCode}: ${stdout}`,
    );
  }
  let roots: HostTrustedRoot[];
  try {
    roots = parseTrustedRootsResult(stdout);
  } catch {
    throw new HostTrustStoreError(`hostTrustStore: could not parse enumeration output: ${stdout}`);
  }
  return dedupeBySha256(roots);
}
