#!/usr/bin/env node
import { Command } from 'commander';
import packageJson from '../package.json';
import { registerInit } from './commands/init';
import { registerImportSbxNetworkPolicy } from './commands/importSbxNetworkPolicy';
import { registerBuildEnvoyConfig } from './commands/buildEnvoyConfig';
import { registerWriteGithubConfig } from './commands/writeGithubConfig';
import { registerRunProxy } from './commands/runProxy';

const program = new Command();

program
  .name('configamatron')
  .description('CLI for building the Envoy sandbox proxy config from a network policy allow list')
  .version(packageJson.version, '-v, --version', 'output the version number');

registerInit(program);
registerImportSbxNetworkPolicy(program);
registerBuildEnvoyConfig(program);
registerWriteGithubConfig(program);
registerRunProxy(program);

await program.parseAsync();
