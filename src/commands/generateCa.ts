import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import { generateCaPems, validateCaPair } from '../ca';

export function registerGenerateCa(program: Command): void {
  program
    .command('generate-ca')
    .description(
      'Generate the proxy CA into .configamatron/proxy/ca and copy cert.pem into vm-shared. ' +
        'Reuses an existing valid pair.',
    )
    .action(() => {
      const paths = requireEnvPathsOrExit('generate-ca');
      if (!paths) return;

      const certExists = existsSync(paths.caCert);
      const keyExists = existsSync(paths.caKey);

      if (certExists !== keyExists) {
        console.error(
          `generate-ca: found only one of ${paths.caCert} / ${paths.caKey} — delete it and re-run`,
        );
        process.exitCode = 1;
        return;
      }

      if (certExists && keyExists) {
        const certPem = readFileSync(paths.caCert, 'utf8');
        const keyPem = readFileSync(paths.caKey, 'utf8');
        if (!validateCaPair(certPem, keyPem)) {
          console.error(
            `generate-ca: existing ${paths.caCert} / ${paths.caKey} are not a valid pair — ` +
              'delete them to regenerate (existing key material is never overwritten)',
          );
          process.exitCode = 1;
          return;
        }
        copyFileSync(paths.caCert, paths.vmCert);
        console.log(
          `generate-ca: reusing valid CA in ${paths.caDir}; copied cert.pem to vm-shared`,
        );
        return;
      }

      const { certPem, keyPem } = generateCaPems();
      mkdirSync(paths.caDir, { recursive: true });
      writeFileSync(paths.caCert, certPem);
      writeFileSync(paths.caKey, keyPem);
      copyFileSync(paths.caCert, paths.vmCert);
      console.log(`generate-ca: wrote CA to ${paths.caDir}; copied cert.pem to vm-shared`);
    });
}
