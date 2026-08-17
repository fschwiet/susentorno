import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

/**
 * Imports a PEM cert file into LocalMachine\Root and reports its thumbprint.
 * Not CurrentUser\Root: Import-Certificate into that store requires an
 * interactive confirmation dialog ("UI is not allowed in this operation")
 * regardless of -NonInteractive or elevation — verified directly against a
 * real Windows host. LocalMachine\Root works non-interactively when elevated,
 * which this harness already requires, and hostTrustStore.ts's enumeration
 * dedupes across both stores anyway, so this exercises the identical
 * production diff/dedup path.
 *
 * Uses [X509Certificate2]/[X509Store] directly rather than Import-Certificate
 * with a Cert:\ path: the Cert:\ PSDrive is only registered by PowerShell's
 * console-host startup, not when powershell.exe is spawned as a child
 * process with redirected stdio (execa's case, same as production's
 * createRealPowerShellExec) — confirmed directly against a real host, where
 * every Cert:\ reference fails with "Cannot find drive" in that context.
 */
export function buildImportLocalMachineRootCertCommand(certPath: string): string {
  return (
    `$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(${quoteForPowerShell(certPath)}); ` +
    "$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine'); " +
    "$store.Open('ReadWrite'); $store.Add($cert); $store.Close(); " +
    '[PSCustomObject]@{ Thumbprint = $cert.Thumbprint } | ConvertTo-Json -Compress'
  );
}

export function parseImportedThumbprint(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      `localMachineRoot: certificate import returned no thumbprint: ${stdout || '<empty>'}`,
    );
  }
  const parsed = JSON.parse(trimmed) as { Thumbprint?: unknown };
  if (typeof parsed.Thumbprint !== 'string' || parsed.Thumbprint === '') {
    throw new Error(`localMachineRoot: certificate import returned no thumbprint: ${stdout}`);
  }
  return parsed.Thumbprint;
}

export function buildRemoveLocalMachineRootCertCommand(thumbprint: string): string {
  return (
    "$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine'); " +
    "$store.Open('ReadWrite'); " +
    `$cert = $store.Certificates | Where-Object { $_.Thumbprint -eq ${quoteForPowerShell(thumbprint)} }; ` +
    'if ($cert) { $store.Remove($cert) }; $store.Close()'
  );
}
