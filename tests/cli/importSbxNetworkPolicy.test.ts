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

  it('parses a policy file into current-allow-list.txt and current-auth-list.txt', async () => {
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
        ['*.chatgpt.com:443', 'archive.ubuntu.com:80', ''].join('\n'),
      );
      expect(readFileSync(join(dir, 'current-auth-list.txt'), 'utf8')).toBe(
        ['#pragma claude authenticated', 'api.anthropic.com:443', 'claude.com:443', ''].join('\n'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns and skips unsupported wildcard patterns but still writes both files', async () => {
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
      expect(readFileSync(join(dir, 'current-allow-list.txt'), 'utf8')).toContain(
        '*.chatgpt.com:443',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes to --allow-output and --auth-output when given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-policy.txt', import.meta.url));
    try {
      const { exitCode } = await execa(
        'node',
        [
          cliPath,
          'import-sbx-network-policy',
          fixturePath,
          '--allow-output',
          'my-allow.txt',
          '--auth-output',
          'my-auth.txt',
        ],
        { cwd: dir },
      );
      expect(exitCode).toBe(0);
      expect(readFileSync(join(dir, 'my-allow.txt'), 'utf8')).toContain('*.chatgpt.com:443');
      expect(readFileSync(join(dir, 'my-auth.txt'), 'utf8')).toContain('api.anthropic.com:443');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
