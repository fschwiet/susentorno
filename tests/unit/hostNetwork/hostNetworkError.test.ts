import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { HostNetworkError, runMutation } from '../../../src/hostNetwork/hostNetworkError';

function fakeExec(result: { exitCode: number; stdout: string }): PowerShellExec {
  return {
    async run() {
      return result;
    },
  };
}

describe('runMutation', () => {
  it('resolves when the command exits 0 with no ERROR: line', async () => {
    await expect(
      runMutation(fakeExec({ exitCode: 0, stdout: '' }), 'Some-Command'),
    ).resolves.toBeUndefined();
  });

  it('throws HostNetworkError with the message after "ERROR: " when present', async () => {
    const exec = fakeExec({ exitCode: 1, stdout: 'ERROR: switch already in use\r\n' });
    await expect(runMutation(exec, 'Some-Command')).rejects.toThrow(HostNetworkError);
    await expect(runMutation(exec, 'Some-Command')).rejects.toThrow('switch already in use');
  });

  it('throws a generic HostNetworkError when exit code is non-zero with no ERROR: line', async () => {
    const exec = fakeExec({ exitCode: 1, stdout: '' });
    await expect(runMutation(exec, 'Some-Command')).rejects.toThrow(HostNetworkError);
    await expect(runMutation(exec, 'Some-Command')).rejects.toThrow('exit code 1');
  });
});
