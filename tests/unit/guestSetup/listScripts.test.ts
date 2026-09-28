import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listScripts,
  UNIX_STEP_NAMING,
  WINDOWS_STEP_NAMING,
} from '../../../src/guestSetup/listScripts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'list-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function touch(name: string) {
  writeFileSync(join(dir, name), '');
}

describe('listScripts with UNIX_STEP_NAMING', () => {
  it('returns scripts in numeric-prefix order with the extension-stripped slug', () => {
    touch('02-install-pnpm.sh');
    touch('01-apt-packages.sh');
    touch('05-configure-network.sh');
    const scripts = listScripts(dir, UNIX_STEP_NAMING);
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
    touch('nn-configure-network.sh');
    touch('1-bad.sh');
    const scripts = listScripts(dir, UNIX_STEP_NAMING);
    expect(scripts.map((s) => s.filename)).toEqual(['01-apt-packages.sh']);
  });

  it('returns an empty array for a directory with no matching scripts', () => {
    touch('README.md');
    expect(listScripts(dir, UNIX_STEP_NAMING)).toEqual([]);
  });

  it('works identically for a post-scripts-shaped directory', () => {
    touch('01-auth-config.sh');
    touch('02-apply-home-jq-transforms.sh');
    expect(listScripts(dir, UNIX_STEP_NAMING).map((s) => s.slug)).toEqual([
      'auth-config',
      'apply-home-jq-transforms',
    ]);
  });

  it('matches the .sh extension case-sensitively', () => {
    touch('01-lower.sh');
    touch('02-upper.SH');
    touch('03-mixed.Sh');
    expect(listScripts(dir, UNIX_STEP_NAMING).map((s) => s.filename)).toEqual(['01-lower.sh']);
  });

  it('ignores .ps1 files', () => {
    touch('01-windows-step.ps1');
    touch('02-unix-step.sh');
    expect(listScripts(dir, UNIX_STEP_NAMING).map((s) => s.filename)).toEqual(['02-unix-step.sh']);
  });

  it('ignores directories that look like scripts', () => {
    mkdirSync(join(dir, '01-a-directory.sh'));
    touch('02-a-file.sh');
    expect(listScripts(dir, UNIX_STEP_NAMING).map((s) => s.filename)).toEqual(['02-a-file.sh']);
  });

  it('orders ordinally rather than by locale', () => {
    touch('01-alpha.sh');
    touch('01-Zeta.sh');
    touch('01-beta.sh');
    expect(listScripts(dir, UNIX_STEP_NAMING).map((s) => s.filename)).toEqual([
      '01-Zeta.sh',
      '01-alpha.sh',
      '01-beta.sh',
    ]);
  });
});

describe('listScripts with WINDOWS_STEP_NAMING', () => {
  it('returns NN-name.ps1 scripts in numeric-prefix order with the extension-stripped slug', () => {
    touch('05-configure-network.ps1');
    touch('01-install-tools.ps1');
    touch('02-set-path.ps1');
    const scripts = listScripts(dir, WINDOWS_STEP_NAMING);
    expect(scripts.map((s) => s.filename)).toEqual([
      '01-install-tools.ps1',
      '02-set-path.ps1',
      '05-configure-network.ps1',
    ]);
    expect(scripts.map((s) => s.slug)).toEqual(['install-tools', 'set-path', 'configure-network']);
    expect(scripts[0].path).toBe(join(dir, '01-install-tools.ps1'));
  });

  it('matches the .ps1 extension case-insensitively, preserving the filename and slug case', () => {
    touch('01-lower.ps1');
    touch('02-upper.PS1');
    touch('03-Mixed-Name.Ps1');
    const scripts = listScripts(dir, WINDOWS_STEP_NAMING);
    expect(scripts.map((s) => s.filename)).toEqual([
      '01-lower.ps1',
      '02-upper.PS1',
      '03-Mixed-Name.Ps1',
    ]);
    expect(scripts.map((s) => s.slug)).toEqual(['lower', 'upper', 'Mixed-Name']);
  });

  it('ignores files that are not NN-name.ps1', () => {
    touch('01-install-tools.ps1');
    touch('README.md');
    touch('nn-configure-network.ps1');
    touch('1-bad.ps1');
    touch('02-unix-step.sh');
    touch('03-no-extension');
    touch('04-.ps1');
    touch('05-extra.ps1.txt');
    expect(listScripts(dir, WINDOWS_STEP_NAMING).map((s) => s.filename)).toEqual([
      '01-install-tools.ps1',
    ]);
  });

  it('ignores directories that look like scripts', () => {
    mkdirSync(join(dir, '01-a-directory.ps1'));
    touch('02-a-file.ps1');
    expect(listScripts(dir, WINDOWS_STEP_NAMING).map((s) => s.filename)).toEqual(['02-a-file.ps1']);
  });

  it('orders ordinally rather than by locale or case-folded name', () => {
    touch('01-alpha.ps1');
    touch('01-Zeta.ps1');
    touch('01-beta.PS1');
    expect(listScripts(dir, WINDOWS_STEP_NAMING).map((s) => s.filename)).toEqual([
      '01-Zeta.ps1',
      '01-alpha.ps1',
      '01-beta.PS1',
    ]);
  });

  it('returns an empty array for a directory with no matching scripts', () => {
    touch('README.md');
    expect(listScripts(dir, WINDOWS_STEP_NAMING)).toEqual([]);
  });
});
