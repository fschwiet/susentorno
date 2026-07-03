import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { validateGithubTokenFormat } from '../githubToken';
import { formatGithubConfig } from '../githubConfig';

const OUTPUT_PATH = 'vm/github-config.txt';

function readGitConfigValue(key: string): string {
  try {
    return execFileSync('git', ['config', '--global', key], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function registerWriteGithubConfig(program: Command): void {
  program
    .command('write-github-config')
    .description(
      'Prompt for a GitHub fine-grained PAT and write vm/github-config.txt for the VM setup scripts',
    )
    .action(async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const token = (await rl.question('GitHub fine-grained PAT: ')).trim();
      rl.close();

      const tokenError = validateGithubTokenFormat(token);
      if (tokenError) {
        console.error(`write-github-config: invalid token - ${tokenError}`);
        process.exitCode = 1;
        return;
      }

      const username = readGitConfigValue('user.name');
      const email = readGitConfigValue('user.email');
      if (!username || !email) {
        console.error(
          'write-github-config: git config --global user.name/user.email must be set first',
        );
        process.exitCode = 1;
        return;
      }

      mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
      writeFileSync(OUTPUT_PATH, formatGithubConfig({ username, email, token }));

      console.log(`write-github-config: wrote ${OUTPUT_PATH} for ${username} <${email}>`);
    });
}
