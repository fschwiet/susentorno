import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));

describe('configamatron CLI', () => {
  it('warns in help that import-sbx-network-policy regeneration drops comments', async () => {
    const { stdout, exitCode } = await execa('node', [
      cliPath,
      'import-sbx-network-policy',
      '--help',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      'does not preserve customizations since last import, including hand-added comments',
    );
  });

  it('prints the version with --version', async () => {
    const { stdout, exitCode } = await execa('node', [cliPath, '--version']);
    expect(stdout.trim()).toBe('0.0.1');
    expect(exitCode).toBe(0);
  });

  it('lists run-proxy with its flags in help output', async () => {
    const { stdout, exitCode } = await execa('node', [cliPath, 'run-proxy', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--credentials');
    expect(stdout).toContain('--no-refresh');
    expect(stdout).toContain('--upstream-override');
  });

  it('run-proxy names the missing prerequisite command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      const { exitCode, stderr } = await execa('node', [cliPath, 'run-proxy'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("run 'configamatron generate-ca' first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a policy file into current-allow-list.txt with import-sbx-network-policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-policy.txt', import.meta.url));

    try {
      const { exitCode } = await execa(
        'node',
        [cliPath, 'import-sbx-network-policy', fixturePath],
        { cwd: dir },
      );

      expect(exitCode).toBe(0);
      expect(readFileSync(join(dir, 'current-allow-list.txt'), 'utf8')).toBe(
        [
          '#pragma passthrough',
          '*.chatgpt.com:443',
          'archive.ubuntu.com:80',
          '',
          '#pragma claude authenticated',
          'api.anthropic.com:443',
          'claude.com:443',
          '',
        ].join('\n'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns and skips unsupported wildcard patterns but still writes the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-policy.txt', import.meta.url));

    try {
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'import-sbx-network-policy', fixturePath],
        { cwd: dir },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toContain('foo*.bar.com:443');
      const written = readFileSync(join(dir, 'current-allow-list.txt'), 'utf8');
      expect(written).toContain('*.chatgpt.com:443');
      expect(written).not.toContain('foo*.bar.com');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('write-github-config', () => {
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
          'GITHUB_TOKEN="ghp-SANDBOX-PLACEHOLDER"',
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
