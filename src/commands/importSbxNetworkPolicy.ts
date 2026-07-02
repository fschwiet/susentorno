import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { parsePolicyFile } from '../policyFile';
import { formatAllowlist } from '../allowlist';

export function registerImportSbxNetworkPolicy(program: Command): void {
  program
    .command('import-sbx-network-policy')
    .description('Parse a network policy file into allowlist.txt')
    .argument('<policyFile>', 'path to the source policy file')
    .option('-o, --output <path>', 'output allowlist file path', 'allowlist.txt')
    .action((policyFile: string, options: { output: string }) => {
      const content = readFileSync(policyFile, 'utf8');
      const allowlist = parsePolicyFile(content);
      writeFileSync(options.output, formatAllowlist(allowlist));
    });
}
