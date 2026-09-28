import { describe, expect, it } from 'vitest';
import {
  assertGuestElevated,
  createWindowsGuestExec,
  waitForPowerShellDirect,
  WindowsGuestExecError,
} from '../../guest/windowsGuestExec';
import {
  WindowsGuestError,
  type WindowsGuestExecutor,
  type WindowsGuestResult,
} from '../../../src/guestSetup/windows/guestExecutor';

function executorReturning(
  outcome: WindowsGuestResult | WindowsGuestError,
  seen: { script: string; timeoutMs: number }[] = [],
): WindowsGuestExecutor {
  return {
    vmName: 'vm',
    async invoke(script, options) {
      seen.push({ script, timeoutMs: options.timeoutMs });
      if (outcome instanceof WindowsGuestError) throw outcome;
      return outcome;
    },
    async dispose() {},
  };
}

const done = (stdout: string, stderr = '', exitCode = 0): WindowsGuestResult => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
});

describe('createWindowsGuestExec', () => {
  it('runs scripts through the production executor with a bounded timeout', async () => {
    const seen: { script: string; timeoutMs: number }[] = [];
    const guest = createWindowsGuestExec(executorReturning(done('ok\n'), seen), 1234);
    expect(guest.vmName).toBe('vm');
    expect(await guest.capture('whoami')).toEqual({ exitCode: 0, stdout: 'ok\n' });
    expect(seen).toEqual([{ script: 'whoami', timeoutMs: 1234 }]);
  });

  it('shows stderr after stdout so a failure message keeps both', async () => {
    const guest = createWindowsGuestExec(executorReturning(done('out\n', 'err\n', 3)));
    expect(await guest.run('x')).toEqual({ exitCode: 3, stdout: 'out\nerr\n' });
  });
});

describe('waitForPowerShellDirect (harness policy)', () => {
  it('resolves once the guest answers', async () => {
    await expect(
      waitForPowerShellDirect(executorReturning(done('ready'))),
    ).resolves.toBeUndefined();
  });

  it('fails clearly, without retrying, when the guest rejects the credential', async () => {
    const rejected = new WindowsGuestError('authentication', 'The credential is invalid.');
    await expect(waitForPowerShellDirect(executorReturning(rejected))).rejects.toThrow(
      /rejected the harness credential/,
    );
  });

  it('keeps the OOBE-failed hint when the guest never answers', async () => {
    const notReady = new WindowsGuestError('transport', 'The virtual machine is not running.');
    await expect(
      waitForPowerShellDirect(executorReturning(notReady), { timeoutMs: 1 }),
    ).rejects.toThrow(/OOBE-failed signature/);
  });

  it('lets a bridge protocol failure through untouched', async () => {
    const broken = new WindowsGuestError('protocol', 'bridge exploded');
    await expect(waitForPowerShellDirect(executorReturning(broken))).rejects.toBe(broken);
  });
});

describe('assertGuestElevated', () => {
  it('passes when the guest reports an administrative token', async () => {
    await expect(
      assertGuestElevated(createWindowsGuestExec(executorReturning(done('True')))),
    ).resolves.toBeUndefined();
  });

  it('throws when the token came back filtered', async () => {
    await expect(
      assertGuestElevated(createWindowsGuestExec(executorReturning(done('False')))),
    ).rejects.toThrow(WindowsGuestExecError);
  });
});
