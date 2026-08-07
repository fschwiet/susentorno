import { describe, it, expect } from 'vitest';
import { buildPowerShellArgv } from '../../../src/guestSetup/powerShellExec';

describe('buildPowerShellArgv', () => {
  it('wraps the command with -NoProfile -NonInteractive -Command as one argv element', () => {
    expect(buildPowerShellArgv('Get-VM -Name x')).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-VM -Name x',
    ]);
  });
});
