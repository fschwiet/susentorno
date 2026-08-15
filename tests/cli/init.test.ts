import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));

describe('susentorno init', () => {
  it('scaffolds .susentorno and prints next steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-init-'));
    try {
      const { exitCode, stdout } = await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain('generate-ca');
      expect(stdout).toContain('update-shares');
      expect(stdout).toContain('home-jq-transforms');
      expect(existsSync(join(dir, '.susentorno', 'proxy', 'allow-list.txt'))).toBe(true);
      expect(existsSync(join(dir, '.susentorno', 'proxy', 'auth-list.txt'))).toBe(true);
      expect(existsSync(join(dir, '.susentorno', 'proxy', 'block-list.txt'))).toBe(true);
      expect(existsSync(join(dir, '.susentorno', 'vm-shared-linux', 'credentials.json'))).toBe(
        true,
      );
      expect(
        existsSync(
          join(dir, '.susentorno', 'vm-shared-linux', 'pre-scripts', '04-configure-network.sh'),
        ),
      ).toBe(true);
      expect(existsSync(join(dir, '.susentorno', 'pre-scripts', 'README.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when .susentorno already exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-init-'));
    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir, reject: false },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('already exists');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 with a pointer at the claude CLI when credentials are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-init-'));
    try {
      const { exitCode, stderr } = await execa(
        'node',
        [
          cliPath,
          'init',
          '--credentials',
          join(dir, 'missing.json'),
          '--codex-credentials',
          authFixture,
        ],
        { cwd: dir, reject: false },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('could not read credentials');
      expect(existsSync(join(dir, '.susentorno'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
