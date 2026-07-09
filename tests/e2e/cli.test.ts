import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));

describe('configamatron CLI', () => {
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
    expect(stdout).toContain('--service');
  });

  it('run-proxy names the missing prerequisite command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stderr } = await execa('node', [cliPath, 'run-proxy'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("run 'configamatron build-envoy-config' first");
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
          '# passthrough',
          '**.chatgpt.com:443',
          'archive.ubuntu.com:80',
          '',
          '# terminate',
          'api.anthropic.com:443',
          'claude.com:443',
          '',
        ].join('\n'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates envoy.yaml into the environment by default with build-envoy-config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-allowlist.txt', import.meta.url));

    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode } = await execa(
        'node',
        [
          cliPath,
          'build-envoy-config',
          fixturePath,
          '--upstream-override',
          'api.anthropic.com=127.0.0.1:9443',
        ],
        { cwd: dir },
      );

      expect(exitCode).toBe(0);
      const outputPath = join(dir, '.configamatron', 'proxy', 'envoy.yaml');
      const config = parse(readFileSync(outputPath, 'utf8')) as any;

      const matchingClusters = config.static_resources.clusters.filter(
        (c: any) => c.name === 'cluster_terminate_api_anthropic_com',
      );
      expect(matchingClusters).toHaveLength(1);
      const cluster = matchingClusters[0];
      expect(
        cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
      ).toEqual({ address: '127.0.0.1', port_value: 9443 });

      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const matchingFilterChains = listener443.filter_chains.filter((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
      );
      expect(matchingFilterChains).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('build-envoy-config rejects an allowlist with unsupported wildcard syntax', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const fixturePath = fileURLToPath(
      new URL('../fixtures/invalid-allowlist.txt', import.meta.url),
    );

    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'build-envoy-config', fixturePath],
        { cwd: dir, reject: false },
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain('crl*.digicert.com:80');
      expect(existsSync(join(dir, '.configamatron', 'proxy', 'envoy.yaml'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('build-envoy-config exits 1 without an environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    try {
      const { exitCode, stderr } = await execa('node', [cliPath, 'build-envoy-config'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("run 'configamatron init' first");
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

  it('writes vm-shared/github-config.txt from a valid token and host git identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(
      gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    );

    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stdout } = await execa('node', [cliPath, 'write-github-config'], {
        cwd: dir,
        input: `${validToken}\n`,
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('github-config.txt for Test User <test@example.com>');
      expect(
        readFileSync(join(dir, '.configamatron', 'vm-shared', 'github-config.txt'), 'utf8'),
      ).toBe(
        [
          'GITHUB_USERNAME="Test User"',
          'GITHUB_EMAIL="test@example.com"',
          `GITHUB_TOKEN="${validToken}"`,
          '',
        ].join('\n'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed token without writing the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(
      gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    );

    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stderr } = await execa('node', [cliPath, 'write-github-config'], {
        cwd: dir,
        input: 'not-a-real-token\n',
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
        reject: false,
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('invalid token');
      expect(existsSync(join(dir, '.configamatron', 'vm-shared', 'github-config.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when git user.name/user.email are not set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(gitConfigPath, '');

    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
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

  it('lists proxy-logs with its flags in help output', async () => {
    const { stdout, exitCode } = await execa('node', [cliPath, 'proxy-logs', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--blocked');
    expect(stdout).toContain('--unique');
    expect(stdout).toContain('--debounce');
    expect(stdout).toContain('--no-follow');
  });

  it('proxy-logs exits 1 without an environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    try {
      const { exitCode, stderr } = await execa('node', [cliPath, 'proxy-logs'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("run 'configamatron init' first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proxy-logs rejects --unique together with --debounce', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'proxy-logs', '--unique', '--debounce', '30'],
        { cwd: dir, reject: false },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('mutually exclusive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
