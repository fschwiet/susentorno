import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      expect(cfg, folder).toContain('GITHUB_TOKEN="ghp-CONFIGAMATRON-PLACEHOLDER"');
      expect(cfg, folder).not.toContain(token);
    }

    const apiTokenSecret = readFileSync(
      join(dir, '.configamatron', 'proxy', 'secrets', 'github-api-token-secret.yaml'),
      'utf8',
    );
    expect(apiTokenSecret).toContain(`inline_string: "token ${token}"`);
  });

  // Moved from cli.test.ts: these cases build their own environment per test
  // (temp dir, gitconfig file, init) rather than relying on the shared
  // beforeEach/afterEach above, so their setup is kept exactly as it was.
  const validToken = 'github_pat_' + 'A'.repeat(82);

  function writeFixtureGitConfig(path: string, contents: string): void {
    writeFileSync(path, contents);
  }

  it('writes a placeholder VM config and the real credential to the github secret files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(
      gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    );

    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      const { exitCode, stdout } = await execa('node', [cliPath, 'write-github-config'], {
        cwd: dir,
        input: `${validToken}\n`,
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
      });

      expect(exitCode).toBe(0);
      // The real token is never printed.
      expect(stdout).not.toContain(validToken);

      // VM share gets identity + the placeholder PAT, never the real token.
      const vmConfig = readFileSync(
        join(dir, '.configamatron', 'vm-shared', 'github-config.txt'),
        'utf8',
      );
      expect(vmConfig).toBe(
        [
          'GITHUB_USERNAME="Test User"',
          'GITHUB_EMAIL="test@example.com"',
          'GITHUB_TOKEN="ghp-CONFIGAMATRON-PLACEHOLDER"',
          '',
        ].join('\n'),
      );
      expect(vmConfig).not.toContain(validToken);

      // The real credential lands only in the proxy secrets, one resource per file.
      const basicSecret = readFileSync(
        join(dir, '.configamatron', 'proxy', 'secrets', 'github-basic-secret.yaml'),
        'utf8',
      );
      expect(basicSecret).toContain('name: github_basic_auth');
      const expectedBasic = 'Basic ' + Buffer.from(`Test User:${validToken}`).toString('base64');
      expect(basicSecret).toContain(`inline_string: "${expectedBasic}"`);

      const apiTokenSecret = readFileSync(
        join(dir, '.configamatron', 'proxy', 'secrets', 'github-api-token-secret.yaml'),
        'utf8',
      );
      expect(apiTokenSecret).toContain('name: github_api_token');
      expect(apiTokenSecret).toContain(`inline_string: "token ${validToken}"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed token without writing either output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(
      gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    );

    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      const { exitCode, stderr } = await execa('node', [cliPath, 'write-github-config'], {
        cwd: dir,
        input: 'not-a-real-token\n',
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
        reject: false,
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('invalid token');
      expect(existsSync(join(dir, '.configamatron', 'vm-shared', 'github-config.txt'))).toBe(false);
      expect(
        existsSync(join(dir, '.configamatron', 'proxy', 'secrets', 'github-basic-secret.yaml')),
      ).toBe(false);
      expect(
        existsSync(join(dir, '.configamatron', 'proxy', 'secrets', 'github-api-token-secret.yaml')),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when git user.name/user.email are not set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(gitConfigPath, '');

    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      const { exitCode, stderr } = await execa('node', [cliPath, 'write-github-config'], {
        cwd: dir,
        input: `${validToken}\n`,
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
        reject: false,
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('user.name/user.email');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
