import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildVmEvidenceCommand,
  findKernelFailure,
  rotateAttempt,
} from '../../guest/hyperv/goldenBuildEvidence';

describe('findKernelFailure', () => {
  it('matches the kernel failure lines seen in the installer oops', () => {
    for (const line of [
      '[ 2458.169321] BUG: unable to handle page fault for address: ffffffffc0815f50',
      '[ 2458.180263] Oops: Oops: 0000 [#1] SMP NOPTI',
      '[ 2474.490586] Oops: general protection fault, probably for non-canonical address 0xccccccccccccccfd: 0000 [#2] SMP NOPTI',
      '[   12.000000] Kernel panic - not syncing: VFS: Unable to mount root fs',
    ])
      expect(findKernelFailure(`ok line\n${line}\nnext`), line).toBe(line);
  });

  it('ignores healthy installer output', () => {
    const healthy = [
      'start: subiquity/Mirror/cmd-apt-config: curtin command apt-config',
      'finish: subiquity/Install/install/configure_apt: SUCCESS: configuring apt',
      '[  OK  ] Started systemd-journald.service - Journal Service.',
      'cloud-init[1234]: Cloud-init v. 25.1 running modules:final',
      'Reached target multi-user.target - Multi-User System.',
    ].join('\r\n');
    expect(findKernelFailure(healthy)).toBeUndefined();
  });

  it('returns the first match without a trailing carriage return', () => {
    expect(findKernelFailure('a\r\nBUG: x\r\nOops: y\r\n')).toBe('BUG: x');
  });
});

describe('rotateAttempt', () => {
  it('moves current to previous and starts a fresh current', () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-'));
    try {
      const first = rotateAttempt(root);
      expect(first.current).toBe(join(root, 'current'));
      expect(existsSync(first.current)).toBe(true);
      expect(existsSync(first.previous)).toBe(false);
      writeFileSync(join(first.current, 'serial.log'), 'one');

      const second = rotateAttempt(root);
      expect(readFileSync(join(second.previous, 'serial.log'), 'utf8')).toBe('one');
      expect(existsSync(join(second.current, 'serial.log'))).toBe(false);
      writeFileSync(join(second.current, 'serial.log'), 'two');
      writeFileSync(join(second.current, 'extra.txt'), 'x');

      const third = rotateAttempt(root);
      expect(readFileSync(join(third.previous, 'serial.log'), 'utf8')).toBe('two');
      expect(existsSync(join(third.previous, 'extra.txt'))).toBe(true);
      expect(readdirNames(third.current)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replaces a stale previous directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-'));
    try {
      mkdirSync(join(root, 'previous'));
      writeFileSync(join(root, 'previous', 'old.txt'), 'old');
      const paths = rotateAttempt(root);
      expect(existsSync(join(paths.previous, 'old.txt'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}

describe('buildVmEvidenceCommand', () => {
  const command = buildVmEvidenceCommand("vm'name");
  it('quotes the VM name', () => {
    expect(command).toContain("'vm''name'");
  });
  it('asks Get-VM for the diagnostic properties', () => {
    for (const property of [
      'State',
      'Uptime',
      'CPUUsage',
      'MemoryAssigned',
      'MemoryDemand',
      'Heartbeat',
    ])
      expect(command).toContain(property);
  });
});
