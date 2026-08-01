import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

describe('susentorno import-sbx-network-policy', () => {
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

  it('parses a policy file into current-allow-list.txt with import-sbx-network-policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
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
