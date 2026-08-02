import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
