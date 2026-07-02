#!/usr/bin/env node
import { Command } from 'commander';
import packageJson from '../package.json';
import { registerImportSbxNetworkPolicy } from './commands/importSbxNetworkPolicy';
import { registerBuildEnvoyConfig } from './commands/buildEnvoyConfig';

const program = new Command();

program
  .name('configamatron')
  .description('CLI for building the Envoy sandbox proxy config from a network policy allow list')
  .version(packageJson.version, '-v, --version', 'output the version number');

registerImportSbxNetworkPolicy(program);
registerBuildEnvoyConfig(program);

program.parse();
