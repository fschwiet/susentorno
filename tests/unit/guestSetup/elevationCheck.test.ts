import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { buildElevationCheckCommand, isElevated } from '../../../src/guestSetup/elevationCheck';

describe('buildElevationCheckCommand', () => {
  it('checks the current identity against the Administrator role', () => {
    const command = buildElevationCheckCommand();
    expect(command).toContain('WindowsIdentity]::GetCurrent()');
    expect(command).toContain('WindowsBuiltInRole]::Administrator');
  });
});

describe('isElevated', () => {
  it('is true when the check reports True', async () => {
    const exec: PowerShellExec = {
      async run() {
        return { exitCode: 0, stdout: 'True\r\n' };
      },
    };
    expect(await isElevated(exec)).toBe(true);
  });

  it('is false when the check reports False', async () => {
    const exec: PowerShellExec = {
      async run() {
        return { exitCode: 0, stdout: 'False\r\n' };
      },
    };
    expect(await isElevated(exec)).toBe(false);
  });

  it('is false for unexpected output rather than assuming elevation', async () => {
    const exec: PowerShellExec = {
      async run() {
        return { exitCode: 1, stdout: '' };
      },
    };
    expect(await isElevated(exec)).toBe(false);
  });
});
