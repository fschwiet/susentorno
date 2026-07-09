import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { requireEnvPathsOrExit, type EnvPaths } from '../envPaths';
import { parseAllowlist, terminateTlsHosts } from '../allowlist';
import { generateRootCa, generateLeaf, validateCaPair, isSignedBy, certSans } from '../ca';

function sameHosts(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((value, i) => value === sb[i]);
}

function deriveSans(paths: EnvPaths): string[] {
  if (!existsSync(paths.allowlist)) return [];
  return terminateTlsHosts(parseAllowlist(readFileSync(paths.allowlist, 'utf8')));
}

/** Ensure a valid leaf for `sans` exists, signed by the given root. Returns a status word. */
function ensureLeaf(paths: EnvPaths, caCertPem: string, caKeyPem: string, sans: string[]): string {
  if (sans.length === 0) return 'no terminate hosts in the allowlist, skipped leaf';

  const leafValid =
    existsSync(paths.caLeafCert) &&
    existsSync(paths.caLeafKey) &&
    (() => {
      const leafCertPem = readFileSync(paths.caLeafCert, 'utf8');
      const leafKeyPem = readFileSync(paths.caLeafKey, 'utf8');
      return (
        validateCaPair(leafCertPem, leafKeyPem) &&
        isSignedBy(leafCertPem, caCertPem) &&
        sameHosts(certSans(leafCertPem), sans)
      );
    })();

  if (leafValid) return `reused leaf for ${sans.length} host(s)`;

  const { leafCertPem, leafKeyPem } = generateLeaf(caCertPem, caKeyPem, sans);
  writeFileSync(paths.caLeafCert, leafCertPem);
  writeFileSync(paths.caLeafKey, leafKeyPem);
  return `issued leaf for ${sans.length} host(s)`;
}

export function registerGenerateCa(program: Command): void {
  program
    .command('generate-ca')
    .description(
      'Generate the proxy root CA and the leaf it signs into .configamatron/proxy/ca, copy the ' +
        'root cert.pem into vm-shared, and derive the leaf SANs from the allowlist terminate ' +
        'section. Reuses existing valid material; reissues the leaf without touching the root.',
    )
    .action(() => {
      const paths = requireEnvPathsOrExit('generate-ca');
      if (!paths) return;

      const caCertExists = existsSync(paths.caCert);
      const caKeyExists = existsSync(paths.caKey);
      if (caCertExists !== caKeyExists) {
        console.error(
          `generate-ca: found only one of ${paths.caCert} / ${paths.caKey} — delete it and re-run`,
        );
        process.exitCode = 1;
        return;
      }

      const sans = deriveSans(paths);
      mkdirSync(paths.caDir, { recursive: true });

      let caCertPem: string;
      let caKeyPem: string;
      let caStatus: string;

      if (caCertExists && caKeyExists) {
        caCertPem = readFileSync(paths.caCert, 'utf8');
        caKeyPem = readFileSync(paths.caKey, 'utf8');
        if (!validateCaPair(caCertPem, caKeyPem)) {
          console.error(
            `generate-ca: existing ${paths.caCert} / ${paths.caKey} are not a valid pair — ` +
              'delete them to regenerate (existing key material is never overwritten)',
          );
          process.exitCode = 1;
          return;
        }
        caStatus = 'reused root CA';
      } else {
        const root = generateRootCa();
        caCertPem = root.caCertPem;
        caKeyPem = root.caKeyPem;
        writeFileSync(paths.caCert, caCertPem);
        writeFileSync(paths.caKey, caKeyPem);
        caStatus = 'wrote new root CA';
      }

      const leafStatus = ensureLeaf(paths, caCertPem, caKeyPem, sans);
      copyFileSync(paths.caCert, paths.vmCert);
      console.log(`generate-ca: ${caStatus}; ${leafStatus}; copied cert.pem to vm-shared`);
    });
}
