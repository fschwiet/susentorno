import { describe, it, expect } from 'vitest';
import {
  buildPowerShellArgv,
  buildPowerShellFileArgv,
} from '../../../src/guestSetup/powerShellExec';

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

describe('buildPowerShellFileArgv', () => {
  it('wraps a script path with -NoProfile -NonInteractive -File', () => {
    expect(buildPowerShellFileArgv('C:\\temp\\script.ps1')).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-File',
      'C:\\temp\\script.ps1',
    ]);
  });
});
