import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { validateGithubTokenFormat } from '../githubToken';
import { formatGithubConfig } from '../githubConfig';
import { formatGithubSecret } from '../githubSecret';
import { GITHUB_PLACEHOLDER_PAT } from '../githubPlaceholder';
import { requireEnvPathsOrExit } from '../envPaths';

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
      'Prompt for a GitHub fine-grained PAT. Write identity + a placeholder PAT to the VM ' +
        'share, and the real credential only to the proxy secret github-secret.yaml.',
    )
    .action(async () => {
      const paths = requireEnvPathsOrExit('write-github-config');
      if (!paths) return;

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

      // VM share: identity + the placeholder PAT only. No real secret crosses to the VM.
      for (const target of paths.vmSharedTargets) {
        mkdirSync(dirname(target.githubConfig), { recursive: true });
        writeFileSync(
          target.githubConfig,
          formatGithubConfig({ username, email, token: GITHUB_PLACEHOLDER_PAT }),
        );
      }

      // Proxy watched dir: the real credential, in a sibling SDS file run-proxy never rewrites.
      mkdirSync(dirname(paths.githubSecret), { recursive: true });
      writeFileSync(paths.githubSecret, formatGithubSecret(username, token));

      // Never echo the token.
      console.log(
        `write-github-config: wrote placeholder github-config.txt to vm-shared and vm-shared-windows, ` +
          `and the real credential to github-secret.yaml for ${username} <${email}>`,
      );
    });
}
