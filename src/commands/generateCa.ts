import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Command } from 'commander';
import { requireEnvPathsOrExit, type EnvPaths } from '../envPaths';
import { parseAuthListFile, terminateTlsHosts } from '../allowlist';
import { generateRootCa, validateCaPair } from '../ca';
import { ensureLeaf } from '../leaf';

function deriveSans(paths: EnvPaths): string[] {
  if (!existsSync(paths.authList)) return [];
  return terminateTlsHosts(parseAuthListFile(readFileSync(paths.authList, 'utf8')));
}

export function registerGenerateCa(program: Command): void {
  program
    .command('generate-ca')
    .description(
      'Generate the proxy root CA and the leaf it signs: the root cert.pem and the leaf go to ' +
        '.susentorno/proxy/ca, and the root private key goes to .susentorno/ca-private/key.pem ' +
        '(a key found in the old proxy/ca location is moved there). Copy the ' +
        'root cert.pem into vm-shared-linux, and derive the leaf SANs from the auth-list.txt sections the ' +
        'proxy terminates TLS for. Reuses existing valid material; reissues the leaf without ' +
        'touching the root.',
    )
    .action(() => {
      const paths = requireEnvPathsOrExit('generate-ca');
      if (!paths) return;

      let movedKey = false;
      if (existsSync(paths.legacyCaKey)) {
        if (existsSync(paths.caKey)) {
          console.error(
            `generate-ca: root CA keys exist at both ${paths.legacyCaKey} and ${paths.caKey} � ` +
              'neither was changed; delete the one you do not want and re-run',
          );
          process.exitCode = 1;
          return;
        }
        mkdirSync(paths.caPrivateDir, { recursive: true });
        try {
          renameSync(paths.legacyCaKey, paths.caKey);
        } catch {
          copyFileSync(paths.legacyCaKey, paths.caKey);
          rmSync(paths.legacyCaKey);
        }
        movedKey = true;
      }

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
        mkdirSync(paths.caPrivateDir, { recursive: true });
        writeFileSync(paths.caKey, caKeyPem);
        caStatus = 'wrote new root CA';
      }

      const leafStatus = ensureLeaf(paths, caCertPem, caKeyPem, sans);
      for (const target of paths.vmSharedTargets) {
        copyFileSync(paths.caCert, target.cert);
      }
      console.log(
        `generate-ca: ${movedKey ? `moved root CA key from ${paths.legacyCaKey} to ${paths.caKey}; ` : ''}${caStatus}; ${leafStatus}; copied cert.pem to vm-shared-linux and vm-shared-windows`,
      );
    });
}
