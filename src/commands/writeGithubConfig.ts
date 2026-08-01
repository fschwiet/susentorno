import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { validateGithubTokenFormat } from '../githubToken';
import { formatGithubConfig } from '../githubConfig';
import { formatGithubBasicSecret, formatGithubApiTokenSecret } from '../githubSecret';
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
        'share, and the real credential only to the proxy secrets github-basic-secret.yaml ' +
        'and github-api-token-secret.yaml.',
    )
    .action(async () => {
      const paths = requireEnvPathsOrExit('write-github-config');
      if (!paths) return;

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const token = (
        await rl.question(
          "Github personal access tokens can be created at https://github.com/settings/personal-access-tokens/new. To allow changes to a repository be sure to allow access to 'Contents' with read+write permissions.\n\n" +
            'GitHub fine-grained PAT: ',
        )
      ).trim();
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

      // Proxy watched dir: the real credential, in sibling SDS files run-proxy never rewrites.
      // Envoy's filesystem SDS requires one resource per watched file, hence two files.
      mkdirSync(dirname(paths.githubBasicSecret), { recursive: true });
      writeFileSync(paths.githubBasicSecret, formatGithubBasicSecret(username, token));
      writeFileSync(paths.githubApiTokenSecret, formatGithubApiTokenSecret(token));

      // Never echo the token.
      console.log(
        `write-github-config: wrote placeholder github-config.txt to vm-shared-linux and vm-shared-windows, ` +
          `and the real credential to github-basic-secret.yaml and github-api-token-secret.yaml ` +
          `for ${username} <${email}>`,
      );
    });
}
