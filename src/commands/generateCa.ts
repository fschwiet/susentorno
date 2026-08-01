import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { requireEnvPathsOrExit, type EnvPaths } from '../envPaths';
import { parseAllowlist, terminateTlsHosts } from '../allowlist';
import { generateRootCa, validateCaPair } from '../ca';
import { ensureLeaf } from '../leaf';

function deriveSans(paths: EnvPaths): string[] {
  if (!existsSync(paths.allowlist)) return [];
  return terminateTlsHosts(parseAllowlist(readFileSync(paths.allowlist, 'utf8')));
}

export function registerGenerateCa(program: Command): void {
  program
    .command('generate-ca')
    .description(
      'Generate the proxy root CA and the leaf it signs into .susentorno/proxy/ca, copy the ' +
        'root cert.pem into vm-shared, and derive the leaf SANs from the allowlist sections the ' +
        'proxy terminates TLS for. Reuses existing valid material; reissues the leaf without ' +
        'touching the root.',
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
      for (const target of paths.vmSharedTargets) {
        copyFileSync(paths.caCert, target.cert);
      }
      console.log(
        `generate-ca: ${caStatus}; ${leafStatus}; copied cert.pem to vm-shared and vm-shared-windows`,
      );
    });
}
