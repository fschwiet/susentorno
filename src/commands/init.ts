import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { ENV_DIR_NAME } from '../envPaths';
import { initEnvironment } from '../initEnv';
import { packagedAllowlist, templatesDir } from '../templates';

interface InitCommandOptions {
  credentials: string;
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description(`Scaffold ${ENV_DIR_NAME} in the current directory for a new environment`)
    .option(
      '--credentials <path>',
      'Claude credentials file to sanitize into the VM placeholder credential',
      join(homedir(), '.claude', '.credentials.json'),
    )
    .action((options: InitCommandOptions) => {
      try {
        initEnvironment({
          cwd: process.cwd(),
          credentialsPath: options.credentials,
          templatesDir: templatesDir(),
          allowlistSource: packagedAllowlist(),
        });
      } catch (error) {
        console.error(`init: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`init: created ${ENV_DIR_NAME}. Next steps:`);
      console.log('  1. configamatron generate-ca');
      console.log('  2. configamatron build-envoy-config');
      console.log('  3. configamatron write-github-config');
      console.log('  4. configamatron run-proxy');
      console.log(
        `  (Windows) admin PowerShell: powershell -File ${ENV_DIR_NAME}/proxy/host-allow-vm-inbound.ps1`,
      );
      console.log(`  Then share ${ENV_DIR_NAME}/vm-shared into the VM — see usage.md`);
    });
}
