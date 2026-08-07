import { describe, it, expect } from 'vitest';
import type { PowerShellExec, PowerShellExecResult } from '../../../src/guestSetup/powerShellExec';
import {
  reconcileVmToSwitch,
  isolateVmToSwitch,
  VmReconcileError,
} from '../../../src/guestSetup/vmReconcile';

function queuedExec(responses: PowerShellExecResult[]): {
  exec: PowerShellExec;
  calls: string[];
  timeoutsByCall: (number | undefined)[];
} {
  const calls: string[] = [];
  const timeoutsByCall: (number | undefined)[] = [];
  const queue = [...responses];
  const exec: PowerShellExec = {
    async run(command: string, opts?: { timeoutMs?: number }) {
      calls.push(command);
      timeoutsByCall.push(opts?.timeoutMs);
      return queue.shift() ?? { exitCode: 0, stdout: '' };
    },
  };
  return { exec, calls, timeoutsByCall };
}

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const vmState = (state: string): PowerShellExecResult => ({
  exitCode: 0,
  stdout: `{"Name":"my-vm","State":"${state}"}`,
});
const adapter = (switchName: string): PowerShellExecResult => ({
  exitCode: 0,
  stdout: `[{"SwitchName":"${switchName}","IPAddresses":[]}]`,
});
const ok: PowerShellExecResult = { exitCode: 0, stdout: '' };
const fail: PowerShellExecResult = { exitCode: 1, stdout: 'The operation failed.' };

describe('reconcileVmToSwitch', () => {
  it('does nothing when already Running on the target switch', async () => {
    const { exec, calls } = queuedExec([vmState('Running'), adapter('susentorno-internal')]);
    const outcome = await reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(outcome).toEqual({ started: false });
    expect(calls.some((c) => c.startsWith('Stop-VM'))).toBe(false);
    expect(calls.some((c) => c.startsWith('Connect-VMNetworkAdapter'))).toBe(false);
    expect(calls.some((c) => c.startsWith('Start-VM'))).toBe(false);
  });

  it('stops, reconnects, and restarts when Running on the wrong switch', async () => {
    const { exec, calls } = queuedExec([
      vmState('Running'),
      adapter('Default Switch'),
      ok,
      vmState('Off'),
      ok,
      ok,
    ]);
    const outcome = await reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(outcome).toEqual({ started: true });
    expect(calls[2]).toBe("Stop-VM -Name 'my-vm'");
    expect(calls[4]).toBe(
      "Connect-VMNetworkAdapter -VMName 'my-vm' -SwitchName 'susentorno-internal'",
    );
    expect(calls[5]).toBe("Start-VM -Name 'my-vm'");
  });

  it('reconnects and starts, without stopping, when Off on the wrong switch', async () => {
    const { exec, calls } = queuedExec([vmState('Off'), adapter('Default Switch'), ok, ok]);
    const outcome = await reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(outcome).toEqual({ started: true });
    expect(calls.some((c) => c.startsWith('Stop-VM'))).toBe(false);
    expect(calls[2]).toBe(
      "Connect-VMNetworkAdapter -VMName 'my-vm' -SwitchName 'susentorno-internal'",
    );
  });

  it('only starts when Off on the correct switch', async () => {
    const { exec, calls } = queuedExec([vmState('Off'), adapter('susentorno-internal'), ok]);
    const outcome = await reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(outcome).toEqual({ started: true });
    expect(calls.some((c) => c.startsWith('Connect-VMNetworkAdapter'))).toBe(false);
    expect(calls[2]).toBe("Start-VM -Name 'my-vm'");
  });

  it('fails with a clear message for an unsupported state, touching nothing', async () => {
    const { exec, calls } = queuedExec([vmState('Saved'), adapter('Default Switch')]);
    await expect(
      reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal'),
    ).rejects.toThrow(VmReconcileError);
    expect(calls).toHaveLength(2);
  });

  it('polls Get-VM until the graceful stop is confirmed Off, retrying while still Running', async () => {
    const clock = fakeClock();
    const { exec } = queuedExec([
      vmState('Running'),
      adapter('Default Switch'),
      ok,
      vmState('Running'),
      vmState('Running'),
      vmState('Off'),
      ok,
      ok,
    ]);
    const outcome = await reconcileVmToSwitch(
      {
        exec,
        vmName: 'my-vm',
        now: clock.now,
        sleep: clock.sleep,
        offPollIntervalMs: 2_000,
        offConfirmTimeoutMs: 30_000,
      },
      'susentorno-internal',
    );
    expect(outcome).toEqual({ started: true });
  });

  it('fails if the VM never reaches Off within the confirmation deadline', async () => {
    const clock = fakeClock();
    const exec: PowerShellExec = {
      async run(command: string) {
        if (command.startsWith('Get-VMNetworkAdapter')) return adapter('Default Switch');
        return vmState('Running');
      },
    };
    await expect(
      reconcileVmToSwitch(
        {
          exec,
          vmName: 'my-vm',
          now: clock.now,
          sleep: clock.sleep,
          offPollIntervalMs: 2_000,
          offConfirmTimeoutMs: 5_000,
        },
        'susentorno-internal',
      ),
    ).rejects.toThrow(/did not reach 'Off'/);
  });

  it('bounds the Stop-VM call itself with a 60-second timeout by default, distinct from the Off-confirmation poll', async () => {
    const { exec, calls, timeoutsByCall } = queuedExec([
      vmState('Running'),
      adapter('Default Switch'),
      ok,
      vmState('Off'),
      ok,
      ok,
    ]);
    await reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(calls[2]).toBe("Stop-VM -Name 'my-vm'");
    expect(timeoutsByCall[2]).toBe(60_000);
    expect(timeoutsByCall[3]).toBeUndefined();
  });

  it('honors a custom stopTimeoutMs', async () => {
    const { exec, calls, timeoutsByCall } = queuedExec([
      vmState('Running'),
      adapter('Default Switch'),
      ok,
      vmState('Off'),
      ok,
      ok,
    ]);
    await reconcileVmToSwitch(
      { exec, vmName: 'my-vm', stopTimeoutMs: 45_000 },
      'susentorno-internal',
    );
    const stopIndex = calls.findIndex((c) => c.startsWith('Stop-VM'));
    expect(timeoutsByCall[stopIndex]).toBe(45_000);
  });

  it('fails when Connect-VMNetworkAdapter exits non-zero, rather than proceeding to Start-VM', async () => {
    const { exec, calls } = queuedExec([vmState('Off'), adapter('Default Switch'), fail]);
    await expect(
      reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal'),
    ).rejects.toThrow(VmReconcileError);
    expect(calls.some((c) => c.startsWith('Start-VM'))).toBe(false);
  });

  it('fails when Start-VM exits non-zero', async () => {
    const { exec } = queuedExec([vmState('Off'), adapter('susentorno-internal'), fail]);
    await expect(
      reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal'),
    ).rejects.toThrow(VmReconcileError);
  });
});

describe('isolateVmToSwitch', () => {
  it('stops, reconnects, and starts when the VM is Running', async () => {
    const { exec, calls } = queuedExec([vmState('Running'), ok, vmState('Off'), ok, ok]);
    await isolateVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(calls[1]).toBe("Stop-VM -Name 'my-vm'");
    expect(calls[3]).toBe(
      "Connect-VMNetworkAdapter -VMName 'my-vm' -SwitchName 'susentorno-internal'",
    );
    expect(calls[4]).toBe("Start-VM -Name 'my-vm'");
  });

  it('reconnects and starts without stopping when the VM is already Off', async () => {
    const { exec, calls } = queuedExec([vmState('Off'), ok, ok]);
    await isolateVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(calls.some((c) => c.startsWith('Stop-VM'))).toBe(false);
    expect(calls[1]).toBe(
      "Connect-VMNetworkAdapter -VMName 'my-vm' -SwitchName 'susentorno-internal'",
    );
  });

  it('fails for an unsupported state rather than guessing', async () => {
    const { exec } = queuedExec([vmState('Paused')]);
    await expect(
      isolateVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal'),
    ).rejects.toThrow(VmReconcileError);
  });

  it('fails when Start-VM exits non-zero after a successful Connect', async () => {
    const { exec } = queuedExec([vmState('Off'), ok, fail]);
    await expect(
      isolateVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal'),
    ).rejects.toThrow(VmReconcileError);
  });
});
