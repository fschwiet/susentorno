#!/usr/bin/env node
import { Command } from 'commander';
import packageJson from '../package.json';
import { registerInit } from './commands/init';
import { registerGenerateCa } from './commands/generateCa';
import { registerImportSbxNetworkPolicy } from './commands/importSbxNetworkPolicy';
import { registerWriteGithubConfig } from './commands/writeGithubConfig';
import { registerRunHosting } from './commands/runHosting';
import { registerUpdateShares } from './commands/updateShares';
import { registerSetupGuestUnix } from './commands/setupGuestUnix';
import { registerCreateHostNetwork } from './commands/createHostNetwork';
import { registerDeleteHostNetwork } from './commands/deleteHostNetwork';

const program = new Command();

program
  .name('susentorno')
  .description('sets up isolated environments for coding agents.')
  .version(packageJson.version, '-v, --version', 'output the version number');

registerInit(program);
registerGenerateCa(program);
registerImportSbxNetworkPolicy(program);
registerWriteGithubConfig(program);
registerRunHosting(program);
registerUpdateShares(program);
registerSetupGuestUnix(program);
registerCreateHostNetwork(program);
registerDeleteHostNetwork(program);

await program.parseAsync();
