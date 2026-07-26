import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));

let dir: string;
let gitConfig: string;
// A syntactically valid fine-grained PAT: the validator requires exactly 93 chars
// (the 'github_pat_' prefix + 82 body chars of [A-Za-z0-9_]). See src/githubToken.ts.
const token = 'github_pat_' + 'A'.repeat(82);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'configamatron-ghcfg-'));
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: dir },
  );
  // Hermetic global git identity via a scratch config the command will read.
  gitConfig = join(dir, 'gitconfig');
  writeFileSync(gitConfig, '');
  const env = { GIT_CONFIG_GLOBAL: gitConfig };
  await execa('git', ['config', '--global', 'user.name', 'octo'], { env });
  await execa('git', ['config', '--global', 'user.email', 'octo@example.com'], { env });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('configamatron write-github-config', () => {
  it('writes github-config.txt into both shared folders', async () => {
    const { exitCode } = await execa('node', [cliPath, 'write-github-config'], {
      cwd: dir,
      input: token + '\n',
      env: { GIT_CONFIG_GLOBAL: gitConfig },
    });
    expect(exitCode).toBe(0);

    for (const folder of ['vm-shared', 'vm-shared-windows']) {
      const cfg = readFileSync(join(dir, '.configamatron', folder, 'github-config.txt'), 'utf8');
      expect(cfg, folder).toContain('GITHUB_USERNAME="octo"');
      expect(cfg, folder).toContain('GITHUB_EMAIL="octo@example.com"');
      expect(cfg, folder).toContain('GITHUB_TOKEN="ghp-SANDBOX-PLACEHOLDER"');
      expect(cfg, folder).not.toContain(token);
    }

    const apiTokenSecret = readFileSync(
      join(dir, '.configamatron', 'proxy', 'secrets', 'github-api-token-secret.yaml'),
      'utf8',
    );
    expect(apiTokenSecret).toContain(`inline_string: "token ${token}"`);
  });
});
