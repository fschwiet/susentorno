#!/usr/bin/env node
import { Command } from 'commander';
import packageJson from '../package.json';
import { registerInit } from './commands/init';
import { registerGenerateCa } from './commands/generateCa';
import { registerImportSbxNetworkPolicy } from './commands/importSbxNetworkPolicy';
import { registerWriteGithubConfig } from './commands/writeGithubConfig';
import { registerRunProxy } from './commands/runProxy';
import { registerUpdateShares } from './commands/updateShares';

const program = new Command();

program
  .name('configamatron')
  .description('CLI for building the Envoy sandbox proxy config from a network policy allow list')
  .version(packageJson.version, '-v, --version', 'output the version number');

registerInit(program);
registerGenerateCa(program);
registerImportSbxNetworkPolicy(program);
registerWriteGithubConfig(program);
registerRunProxy(program);
registerUpdateShares(program);

await program.parseAsync();
