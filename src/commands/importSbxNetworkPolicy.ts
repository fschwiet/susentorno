import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { parsePolicyFile } from '../policyFile';
import { formatAllowlist } from '../allowlist';

export function registerImportSbxNetworkPolicy(program: Command): void {
  program
    .command('import-sbx-network-policy')
    .description(
      'Maintainer command: parse a network policy file into current-allow-list.txt ' +
        '(the tracked default allow list copied into environments by init)',
    )
    .argument('<policyFile>', 'path to the source policy file')
    .option('-o, --output <path>', 'output allow list path', 'current-allow-list.txt')
    .action((policyFile: string, options: { output: string }) => {
      const content = readFileSync(policyFile, 'utf8');
      const allowlist = parsePolicyFile(content);
      if (allowlist.invalid.length > 0) {
        console.warn(
          'import-sbx-network-policy: skipping unsupported wildcard pattern(s):\n' +
            allowlist.invalid.map((entry) => `  - ${entry}`).join('\n'),
        );
      }
      writeFileSync(options.output, formatAllowlist(allowlist));
    });
}
