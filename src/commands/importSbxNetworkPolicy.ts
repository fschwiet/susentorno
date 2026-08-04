import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { parsePolicyFile } from '../policyFile';
import { formatAllowListFile, formatAuthListFile } from '../allowlist';

export function registerImportSbxNetworkPolicy(program: Command): void {
  program
    .command('import-sbx-network-policy')
    .configureHelp({ helpWidth: 300 })
    .description(
      'Maintainer command: parse a network policy file into current-allow-list.txt and ' +
        'current-auth-list.txt (the tracked default allow list and auth list copied into ' +
        'environments by init). Regeneration does not preserve customizations since last ' +
        'import, including hand-added comments.',
    )
    .argument('<policyFile>', 'path to the source policy file')
    .option('--allow-output <path>', 'output allow list path', 'current-allow-list.txt')
    .option('--auth-output <path>', 'output auth list path', 'current-auth-list.txt')
    .action((policyFile: string, options: { allowOutput: string; authOutput: string }) => {
      const content = readFileSync(policyFile, 'utf8');
      const allowlist = parsePolicyFile(content);
      for (const warning of allowlist.warnings)
        console.warn(`import-sbx-network-policy: ${warning}`);
      writeFileSync(options.allowOutput, formatAllowListFile(allowlist.passthrough));
      writeFileSync(options.authOutput, formatAuthListFile(allowlist));
    });
}
