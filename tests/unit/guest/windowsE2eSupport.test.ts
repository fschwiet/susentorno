import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGhShimStagingScript,
  formatRebootEvidence,
  GH_SHIM_DIRECTORY,
  scanArtifactsForSecrets,
  scanTextForSecrets,
} from '../../guest/windowsE2eSupport';

describe('scanTextForSecrets', () => {
  const secrets = [
    { name: 'guest password', value: 'Guest-Secret-1!' },
    { name: 'share password', value: 'Share-Secret-2!' },
  ];

  it('reports the secret by name and never by value', () => {
    const findings = scanTextForSecrets('log.txt', 'ok\nleaked Share-Secret-2! here', secrets);
    expect(findings).toEqual(['log.txt contains the share password']);
    expect(findings.join('')).not.toContain('Share-Secret-2!');
  });

  it('finds a secret written as UTF-16 text (Windows tools often do)', () => {
    const utf16 = Buffer.from('x Guest-Secret-1! y', 'utf16le');
    expect(scanTextForSecrets('cmdkey.txt', utf16, secrets)).toEqual([
      'cmdkey.txt contains the guest password',
    ]);
  });

  it('is clean when nothing matches', () => {
    expect(scanTextForSecrets('log.txt', 'nothing to see', secrets)).toEqual([]);
  });
});

describe('scanArtifactsForSecrets', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('walks nested directories and names the offending file relative to the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-'));
    roots.push(root);
    mkdirSync(join(root, 'windowsE2e', 'screenshots'), { recursive: true });
    writeFileSync(join(root, 'windowsE2e', 'network.txt'), 'clean');
    writeFileSync(join(root, 'windowsE2e', 'screenshots', 'frame.bmp'), 'binary Guest-Secret-1!');
    expect(
      scanArtifactsForSecrets(root, [{ name: 'guest password', value: 'Guest-Secret-1!' }]),
    ).toEqual([`${join('windowsE2e', 'screenshots', 'frame.bmp')} contains the guest password`]);
  });

  it('treats a missing directory as having nothing to scan', () => {
    expect(scanArtifactsForSecrets(join(tmpdir(), 'no-such-dir-xyz'), [])).toEqual([]);
  });
});

describe('formatRebootEvidence', () => {
  const run = [
    'setup-guest-windows: G6 running pre-scripts...',
    'setup-guest-windows: G6 running step pre-scripts/01-install-packages.ps1 (1 of 4)',
    'setup-guest-windows: G6 pre-scripts/01-install-packages.ps1 stdout:',
    '  01-install-packages: installing Git.Git',
    'setup-guest-windows: G6 running step pre-scripts/02-install-pnpm.ps1 (2 of 4)',
    'setup-guest-windows: G6 pre-scripts/02-install-pnpm.ps1 stdout:',
    '  02-install-pnpm: installing Microsoft.VCRedist.2015+.x64 (a restart may be required)',
    'setup-guest-windows: G6 running step pre-scripts/03-install-tools.ps1 (3 of 4)',
    'setup-guest-windows: G7 checking the isolation gate...',
  ].join('\n');

  it('records the production probe and each install step outcome', () => {
    const text = formatRebootEvidence({
      run: 1,
      exitCode: 1,
      log: `${run}\nsetup-guest-windows: failed in phase G6 at step 03-install-tools.ps1 [step-exit]: boom`,
      pendingReboot: { pending: false, markers: [] },
    });
    expect(text).toContain('run 1');
    expect(text).toContain('pending-reboot probe: none');
    expect(text).toContain('01-install-packages.ps1: completed');
    expect(text).toContain('02-install-pnpm.ps1: completed');
    expect(text).toContain('03-install-tools.ps1: failed');
  });

  it('carries output lines that mention a restart or reboot', () => {
    const text = formatRebootEvidence({
      run: 2,
      exitCode: 0,
      log: run,
      pendingReboot: { pending: true, markers: ['Component Based Servicing\\RebootPending'] },
    });
    expect(text).toContain(
      'pending-reboot probe: PENDING (Component Based Servicing\\RebootPending)',
    );
    expect(text).toContain('a restart may be required');
  });

  it('does not mistake the restart-your-shell PATH notice for a reboot request', () => {
    const text = formatRebootEvidence({
      run: 1,
      exitCode: 0,
      log: [
        'setup-guest-windows: G6 running step pre-scripts/01-install-packages.ps1 (1 of 4)',
        '  Path environment variable modified; restart your shell to use the new value.',
        'setup-guest-windows: G7 checking the isolation gate...',
      ].join('\n'),
      pendingReboot: { pending: false, markers: [] },
    });
    expect(text).toContain('01-install-packages.ps1: completed');
    expect(text).not.toContain('reboot-related output');
  });

  it('says so when a step never ran and when the probe itself failed', () => {
    const text = formatRebootEvidence({
      run: 1,
      exitCode: 1,
      log: 'setup-guest-windows: failed in phase G3 guest structural checks [guest-check]: no',
      pendingReboot: { error: 'guest unreachable' },
    });
    expect(text).toContain('pending-reboot probe: could not run (guest unreachable)');
    expect(text).toContain('01-install-packages.ps1: not run');
  });
});

describe('buildGhShimStagingScript', () => {
  const script = buildGhShimStagingScript();

  it('writes a gh.cmd that exits 0 for any arguments', () => {
    expect(script).toContain('gh.cmd');
    expect(script).toContain('exit /b 0');
    expect(script).toContain(GH_SHIM_DIRECTORY);
  });

  it('puts the shim directory first on the MACHINE path, idempotently', () => {
    expect(script).toContain("'Machine'");
    expect(script).toMatch(/SetEnvironmentVariable\('Path'/);
    expect(script).toContain('-ne');
  });
});
