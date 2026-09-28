import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const bridgeRelativePath = 'templates/powershell/windowsGuestBridge.ps1';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('the PowerShell Direct bridge in the packaged build', () => {
  it('is included in the package and sits next to the built CLI at its package-root path', async () => {
    expect(existsSync(join(repoRoot, ...bridgeRelativePath.split('/')))).toBe(true);
    // Scripts stay off so the dry run does not rebuild (and wipe) dist mid-tier.
    const { stdout } = await execa(
      'pnpm',
      ['--config.ignore-scripts=true', 'pack', '--dry-run', '--json'],
      {
        cwd: repoRoot,
        shell: process.platform === 'win32',
      },
    );
    const pack = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { files: { path: string }[] };
    const packed = pack.files.map((file) => file.path);
    expect(packed).toContain(bridgeRelativePath);
    expect(packed).toContain('dist/cli.js');
  });

  it('is not copied into any VM share by init or update-shares', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-not-shared-'));
    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      await execa('node', [cliPath, 'update-shares'], { cwd: dir, reject: false });
      const files = walk(join(dir, '.susentorno')).map((file) => file.toLowerCase());
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((file) => file.includes('windowsguestbridge'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
