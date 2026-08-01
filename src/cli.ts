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
  .description('sets up isolated environments for coding agents.')
  .version(packageJson.version, '-v, --version', 'output the version number');

registerInit(program);
registerGenerateCa(program);
registerImportSbxNetworkPolicy(program);
registerWriteGithubConfig(program);
registerRunProxy(program);
registerUpdateShares(program);

await program.parseAsync();
