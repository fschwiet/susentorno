import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { previewTransforms } from '../../src/homeJqTransforms';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const applierUbuntu = join(
  repoRoot,
  'templates',
  'vm-shared',
  'post-scripts',
  'apply-home-jq-transforms.mjs',
);
const applierWindows = join(
  repoRoot,
  'templates',
  'vm-shared-windows',
  'post-scripts',
  'apply-home-jq-transforms.mjs',
);
const seedDir = join(repoRoot, 'templates', 'home-jq-transforms');

// jq is an external prerequisite; skip the tests that need it when absent rather
// than failing on a machine that lacks it. (The bash-wrapper test, which also
// needs bash, lives in Task 10 alongside the 07-*.sh wrapper it exercises.)
const hasJq = spawnSync('jq', ['--version']).status === 0;
const hasBash = spawnSync('bash', ['--version']).status === 0;

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
    expect(files).toContain('templates/vm-shared/post-scripts/apply-home-jq-transforms.mjs');
    expect(files).toContain(
      'templates/vm-shared-windows/post-scripts/apply-home-jq-transforms.mjs',
    );
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

  it.skipIf(!hasJq)('every seed transform is valid jq that produces a JSON object', () => {
    // previewTransforms loads manifest.yaml and runs each transform through real
    // jq with '{}' input, returning { output } on success or { error } on failure.
    const results = previewTransforms({ dir: seedDir });
    // Guard against a vacuous pass on an emptied manifest.
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      // jq exited 0 and produced output (no error path).
      expect(result.error).toBeUndefined();
      // output is typed `string | undefined`; assert it to both guard the
      // success case and satisfy the JSON.parse below.
      expect(result.output).toBeDefined();
      const parsed = JSON.parse(result.output!);
      // A settings file must be a JSON object. Reject null and arrays (both
      // report typeof 'object'), then reject scalars. No-op `.` and `{}` yield
      // the empty object and intentionally pass; no assertion on keys/values.
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
      expect(typeof parsed).toBe('object');
    }
  });

  // Proves the bash wrapper resolves paths from the script dir, not the caller's
  // cwd. Windows-path handling under Git Bash is finicky, so this runs on
  // POSIX only; CI/Linux covers the wrapper contract. Requires the applier
  // bundle from Task 6 (build before running).
  it.skipIf(!hasBash || !hasJq || process.platform === 'win32')(
    'bash wrapper resolves its sibling mjs and transforms regardless of cwd',
    async () => {
      const share = mkdtempSync(join(tmpdir(), 'share-'));
      try {
        const out = join(share, 'out.json');
        mkdirSync(join(share, 'post-scripts'));
        copyFileSync(applierUbuntu, join(share, 'post-scripts', 'apply-home-jq-transforms.mjs'));
        copyFileSync(
          join(
            repoRoot,
            'templates',
            'vm-shared',
            'post-scripts',
            '02-apply-home-jq-transforms.sh',
          ),
          join(share, 'post-scripts', '02-apply-home-jq-transforms.sh'),
        );
        mkdirSync(join(share, 'home-jq-transforms'));
        writeFileSync(join(share, 'home-jq-transforms', 't.jq'), '.applied = true');
        writeFileSync(
          join(share, 'home-jq-transforms', 'manifest.yaml'),
          `- transform: t.jq\n  linux: ${out}\n`,
        );
        await execa('bash', [join(share, 'post-scripts', '02-apply-home-jq-transforms.sh')], {
          cwd: tmpdir(),
        });
        expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ applied: true });
      } finally {
        rmSync(share, { recursive: true, force: true });
      }
    },
  );
});
