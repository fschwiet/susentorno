import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPreScripts } from '../../../src/guestSetup/listPreScripts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'list-pre-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function touch(name: string) {
  writeFileSync(join(dir, name), '');
}

describe('listPreScripts', () => {
  it('returns scripts in numeric-prefix order with the extension-stripped slug', () => {
    touch('02-install-pnpm.sh');
    touch('01-apt-packages.sh');
    touch('05-configure-network.sh');
    const scripts = listPreScripts(dir);
    expect(scripts.map((s) => s.filename)).toEqual([
      '01-apt-packages.sh',
      '02-install-pnpm.sh',
      '05-configure-network.sh',
    ]);
    expect(scripts.map((s) => s.slug)).toEqual([
      'apt-packages',
      'install-pnpm',
      'configure-network',
    ]);
    expect(scripts[0].path).toBe(join(dir, '01-apt-packages.sh'));
  });

  it('ignores files that are not NN-name.sh', () => {
    touch('01-apt-packages.sh');
    touch('README.md');
    touch('nn-configure-network.sh'); // unwoven sentinel form — should not appear
    touch('1-bad.sh'); // single-digit prefix
    const scripts = listPreScripts(dir);
    expect(scripts.map((s) => s.filename)).toEqual(['01-apt-packages.sh']);
  });

  it('returns an empty array for a directory with no matching scripts', () => {
    touch('README.md');
    expect(listPreScripts(dir)).toEqual([]);
  });
});
