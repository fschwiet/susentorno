import { describe, expect, it } from 'vitest';
import {
  assertGuestElevated,
  buildInvokeDirectCommand,
  createWindowsGuestExec,
  WindowsGuestExecError,
} from '../../guest/windowsGuestExec';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';

const credential = { username: 'Administrator', password: "p'w" };

describe('buildInvokeDirectCommand', () => {
  const command = buildInvokeDirectCommand('vm-1', credential, "Write-Host 'hi'");

  it('addresses the VM by name over the VMBus, never by network address', () => {
    expect(command).toContain('Invoke-Command -VMName');
    expect(command).toContain("'vm-1'");
    expect(command).not.toContain('-ComputerName');
  });

  it('carries the guest script as base64 so nested quoting cannot corrupt it', () => {
    expect(command).toContain(Buffer.from("Write-Host 'hi'", 'utf8').toString('base64'));
    expect(command).not.toContain("Write-Host 'hi'");
    expect(command).toContain('ScriptBlock');
  });

  it('escapes the credential for a PowerShell single-quoted string', () => {
    expect(command).toContain("'p''w'");
  });

  it('round-trips a script containing every awkward metacharacter', () => {
    const nasty = '$x = "a\'b`;\n Write-Host `"$x`" | Out-Null';
    const encoded = Buffer.from(nasty, 'utf8').toString('base64');
    expect(buildInvokeDirectCommand('vm', credential, nasty)).toContain(encoded);
  });
});

describe('createWindowsGuestExec', () => {
  it('returns the guest exit code and stdout', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: 'ok\n' }) };
    const guest = createWindowsGuestExec(exec, 'vm', credential);
    expect(await guest.capture('whoami')).toEqual({ exitCode: 0, stdout: 'ok\n' });
  });
});

describe('assertGuestElevated', () => {
  it('passes when the guest reports an administrative token', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: 'True' }) };
    await expect(
      assertGuestElevated(createWindowsGuestExec(exec, 'vm', credential)),
    ).resolves.toBeUndefined();
  });

  it('throws when the token came back filtered', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: 'False' }) };
    await expect(
      assertGuestElevated(createWindowsGuestExec(exec, 'vm', credential)),
    ).rejects.toThrow(WindowsGuestExecError);
  });
});
