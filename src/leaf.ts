import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { EnvPaths } from './envPaths';
import { generateLeaf, validateCaPair, isSignedBy, certSans, namesIssuerByKey } from './ca';

function sameHosts(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((value, i) => value === sb[i]);
}

/** Ensure a valid leaf for `sans` exists, signed by the given root. Returns a status word. */
export function ensureLeaf(
  paths: EnvPaths,
  caCertPem: string,
  caKeyPem: string,
  sans: string[],
): string {
  if (sans.length === 0) return 'no TLS-terminated hosts in the allowlist, skipped leaf';

  const leafValid =
    existsSync(paths.caLeafCert) &&
    existsSync(paths.caLeafKey) &&
    (() => {
      const leafCertPem = readFileSync(paths.caLeafCert, 'utf8');
      const leafKeyPem = readFileSync(paths.caLeafKey, 'utf8');
      return (
        validateCaPair(leafCertPem, leafKeyPem) &&
        isSignedBy(leafCertPem, caCertPem) &&
        // Reissue leaves from before leaves named their root by key, so an
        // existing environment gets the authorityKeyIdentifier on its next
        // generate-ca even though its root keeps its original name.
        namesIssuerByKey(leafCertPem, caCertPem) &&
        sameHosts(certSans(leafCertPem), sans)
      );
    })();

  if (leafValid) return `reused leaf for ${sans.length} host(s)`;

  const { leafCertPem, leafKeyPem } = generateLeaf(caCertPem, caKeyPem, sans);
  writeFileSync(paths.caLeafCert, leafCertPem);
  writeFileSync(paths.caLeafKey, leafKeyPem);
  return `issued leaf for ${sans.length} host(s)`;
}
