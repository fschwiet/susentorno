import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));

describe('CLI interface', () => {
  it('prints the version with --version', async () => {
    const { stdout, exitCode } = await execa('node', [cliPath, '--version']);
    expect(stdout.trim()).toBe('0.0.1');
    expect(exitCode).toBe(0);
  });

  it('lists run-hosting with its flags in help output', async () => {
    const { stdout, exitCode } = await execa('node', [cliPath, 'run-hosting', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--credentials');
    expect(stdout).toContain('--codex-credentials');
    expect(stdout).toContain('--no-refresh');
    expect(stdout).toContain('--upstream-override');
  });

  it('run-hosting names the missing prerequisite command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      const { exitCode, stderr } = await execa('node', [cliPath, 'run-hosting'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("run 'susentorno generate-ca' first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists --verify-upstream-overrides in run-hosting help', async () => {
    const { stdout } = await execa('node', [cliPath, 'run-hosting', '--help']);
    expect(stdout).toContain('--verify-upstream-overrides');
  });

  it('run-hosting refuses a --verify-upstream-overrides file that does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
      const { exitCode, stderr, stdout } = await execa(
        'node',
        [
          cliPath,
          'run-hosting',
          '--no-refresh',
          '--no-forward',
          '--verify-upstream-overrides',
          join(dir, 'nope.pem'),
        ],
        { cwd: dir, reject: false },
      );
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain('--verify-upstream-overrides');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('run-hosting refuses a --verify-upstream-overrides file that is not a certificate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
      const junk = join(dir, 'junk.pem');
      writeFileSync(junk, 'this is not a certificate\n');
      const { exitCode, stderr, stdout } = await execa(
        'node',
        [
          cliPath,
          'run-hosting',
          '--no-refresh',
          '--no-forward',
          '--verify-upstream-overrides',
          junk,
        ],
        { cwd: dir, reject: false },
      );
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain('not a parseable PEM certificate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
