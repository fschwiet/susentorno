import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));

describe('configamatron init', () => {
  it('scaffolds .configamatron and prints next steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-init-'));
    try {
      const { exitCode, stdout } = await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture],
        { cwd: dir },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain('generate-ca');
      expect(existsSync(join(dir, '.configamatron', 'proxy', 'allowlist.txt'))).toBe(true);
      expect(existsSync(join(dir, '.configamatron', 'vm-shared', 'credentials.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when .configamatron already exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-init-'));
    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture],
        { cwd: dir, reject: false },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('already exists');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 with a pointer at the claude CLI when credentials are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-init-'));
    try {
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'init', '--credentials', join(dir, 'missing.json')],
        { cwd: dir, reject: false },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('could not read credentials');
      expect(existsSync(join(dir, '.configamatron'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
