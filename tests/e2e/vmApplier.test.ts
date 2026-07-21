import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const applierUbuntu = join(repoRoot, 'templates', 'vm-shared', 'apply-home-jq-transforms.mjs');
const applierWindows = join(
  repoRoot,
  'templates',
  'vm-shared-windows',
  'apply-home-jq-transforms.mjs',
);
const seedDir = join(repoRoot, 'templates', 'home-jq-transforms');

// jq is an external prerequisite; skip the tests that need it when absent rather
// than failing on a machine that lacks it. (The bash-wrapper test, which also
// needs bash, lives in Task 10 alongside the 07-*.sh wrapper it exercises.)
const hasJq = spawnSync('jq', ['--version']).status === 0;

describe('vm applier bundle', () => {
  it('is built into both shares', () => {
    expect(existsSync(applierUbuntu)).toBe(true);
    expect(existsSync(applierWindows)).toBe(true);
  });

  it('is listed in the npm package', async () => {
    const { stdout } = await execa(
      'pnpm',
      ['pack', '--dry-run', '--json', '--config.ignore-scripts=true'],
      { cwd: repoRoot },
    );
    const files: string[] = JSON.parse(stdout).files.map((f: { path: string }) => f.path);
    expect(files).toContain('templates/vm-shared/apply-home-jq-transforms.mjs');
    expect(files).toContain('templates/vm-shared-windows/apply-home-jq-transforms.mjs');
  });

  it.skipIf(!hasJq)('applies a transform to its target on this platform (real jq)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'applier-'));
    try {
      const out = join(dir, 'out.json');
      writeFileSync(join(dir, 't.jq'), '.applied = true');
      const key = platform() === 'win32' ? 'windows' : 'linux';
      writeFileSync(
        join(dir, 'manifest.yaml'),
        `- transform: t.jq\n  ${key}: ${out.replace(/\\/g, '/')}\n`,
      );
      const { exitCode } = await execa('node', [applierUbuntu, dir]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ applied: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasJq)('seed transforms reproduce the former inline settings (real jq)', () => {
    const vscode = spawnSync('jq', ['-f', join(seedDir, 'vscode-settings.jq')], {
      input: '{}',
      encoding: 'utf8',
    });
    expect(JSON.parse(vscode.stdout)).toEqual({
      'files.autoSave': 'afterDelay',
      'editor.formatOnSave': true,
      'editor.defaultFormatter': 'esbenp.prettier-vscode',
      '[csharp]': { 'editor.defaultFormatter': 'csharpier.csharpier-vscode' },
    });
    const claude = spawnSync('jq', ['-f', join(seedDir, 'claude-onboarding.jq')], {
      input: '{}',
      encoding: 'utf8',
    });
    expect(JSON.parse(claude.stdout)).toEqual({ hasCompletedOnboarding: true });
  });

  // The bash-wrapper test that exercises 07-apply-home-jq-transforms.sh is added
  // to this file in Task 10, once that wrapper script exists.
});
