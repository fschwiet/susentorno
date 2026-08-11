import { describe, it, expect } from 'vitest';
import { HostNetworkError } from '../../../src/hostNetwork/hostNetworkError';
import { deleteHostNetwork } from '../../../src/hostNetwork/deleteHostNetwork';
import { queuedExec } from './testHelpers';

const HOMEDIR = 'C:\\Users\\me';

describe('deleteHostNetwork', () => {
  it('sweeps rules and removes the switch when everything is present', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '' }, // attached-VM check: none
      { exitCode: 0, stdout: '2,0' }, // interface sweep: 2 removed, 0 failed
      { exitCode: 0, stdout: '1,0' }, // Query User sweep: 1 removed, 0 failed
      { exitCode: 0, stdout: '1,0' }, // named SMB sweep: 1 removed, 0 failed
      { exitCode: 0, stdout: '{"Name":"susentorno-internal"}' }, // Get-VMSwitch: found
      { exitCode: 0, stdout: '' }, // Remove-VMSwitch
    ]);

    const result = await deleteHostNetwork({ exec, homedir: HOMEDIR });

    expect(result).toEqual({
      interfaceSweep: { removed: 2, failed: 0 },
      queryUserSweep: { removed: 1, failed: 0 },
      namedSweep: { removed: 1, failed: 0 },
      switchRemoved: true,
    });
    expect(calls[calls.length - 1]).toContain('Remove-VMSwitch');
  });

  it('is a clean no-op on an already-clean host — switch not found is not an error', async () => {
    const { exec } = queuedExec([
      { exitCode: 0, stdout: '' }, // attached-VM check: none
      { exitCode: 0, stdout: '0,0' }, // interface sweep: nothing found
      { exitCode: 0, stdout: '0,0' }, // Query User sweep: nothing found
      { exitCode: 0, stdout: '0,0' }, // named SMB sweep: nothing found
      { exitCode: 0, stdout: '' }, // Get-VMSwitch: not found
    ]);

    const result = await deleteHostNetwork({ exec, homedir: HOMEDIR });

    expect(result).toEqual({
      interfaceSweep: { removed: 0, failed: 0 },
      queryUserSweep: { removed: 0, failed: 0 },
      namedSweep: { removed: 0, failed: 0 },
      switchRemoved: false,
    });
  });

  it('refuses to proceed when a VM is attached to the switch, naming it', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '{"VMName":"my-guest-vm"}' }, // attached-VM check: one VM
    ]);

    // A single invocation, captured once — calling deleteHostNetwork twice
    // against the same exec would consume the one queued response on the
    // first call and let the second proceed past the guard on the queue's
    // default empty response, masking exactly the behavior this test exists
    // to check.
    let caught: unknown;
    try {
      await deleteHostNetwork({ exec, homedir: HOMEDIR });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HostNetworkError);
    expect((caught as Error).message).toContain('my-guest-vm');
    expect(
      calls.some((c) => c.includes('Remove-NetFirewallRule') || c.includes('Remove-VMSwitch')),
    ).toBe(false);
  });

  it('reports a Remove-VMSwitch failure after every sweep has still run', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '' }, // attached-VM check: none
      { exitCode: 0, stdout: '0,0' }, // interface sweep
      { exitCode: 0, stdout: '0,0' }, // Query User sweep
      { exitCode: 0, stdout: '0,0' }, // named SMB sweep
      { exitCode: 0, stdout: '{"Name":"susentorno-internal"}' }, // Get-VMSwitch: found
      { exitCode: 1, stdout: 'ERROR: switch is in a bad state' }, // Remove-VMSwitch fails
    ]);

    await expect(deleteHostNetwork({ exec, homedir: HOMEDIR })).rejects.toThrow(
      'switch is in a bad state',
    );
    // All three sweeps and the switch-existence check ran before the
    // failure was reported — this command never aborts partway through.
    expect(calls).toHaveLength(6);
  });

  it('reports sweep removal failures while still attempting every later step', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '' }, // attached-VM check: none
      { exitCode: 0, stdout: '1,1' }, // interface sweep: 1 removed, 1 could not be removed
      { exitCode: 0, stdout: '0,0' }, // Query User sweep
      { exitCode: 0, stdout: '0,0' }, // named SMB sweep
      { exitCode: 0, stdout: '{"Name":"susentorno-internal"}' }, // Get-VMSwitch: found
      { exitCode: 0, stdout: '' }, // Remove-VMSwitch: succeeds anyway
    ]);

    await expect(deleteHostNetwork({ exec, homedir: HOMEDIR })).rejects.toThrow(
      '1 firewall rule(s) could not be removed',
    );
    // The switch removal still ran (and succeeded) despite the earlier sweep failure.
    expect(calls[calls.length - 1]).toContain('Remove-VMSwitch');
  });

  it('rejects an invalid isolation name before doing anything', async () => {
    const { exec, calls } = queuedExec([]);

    await expect(deleteHostNetwork({ exec, homedir: HOMEDIR, isolationName: '*' })).rejects.toThrow(
      HostNetworkError,
    );
    expect(calls).toHaveLength(0);
  });

  it('derives names for the given isolation name', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: '0,0' },
      { exitCode: 0, stdout: '0,0' },
      { exitCode: 0, stdout: '0,0' },
      { exitCode: 0, stdout: '' },
    ]);

    await deleteHostNetwork({ exec, homedir: HOMEDIR, isolationName: 'test' });

    expect(calls[0]).toContain('susentorno-test-internal');
    expect(calls[3]).toContain('susentorno-test share (VM inbound)');
  });
});
