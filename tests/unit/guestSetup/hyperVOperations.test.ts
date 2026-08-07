import { describe, it, expect } from 'vitest';
import {
  buildStopVmCommand,
  buildConnectVmNetworkAdapterCommand,
  buildStartVmCommand,
  planVmReconciliation,
} from '../../../src/guestSetup/hyperVOperations';

describe('command builders', () => {
  it('quotes the VM name and switch name', () => {
    expect(buildStopVmCommand("temp'vm")).toBe("Stop-VM -Name 'temp''vm'");
    expect(buildStartVmCommand("temp'vm")).toBe("Start-VM -Name 'temp''vm'");
    expect(buildConnectVmNetworkAdapterCommand("temp'vm", "susentorno's-internal")).toBe(
      "Connect-VMNetworkAdapter -VMName 'temp''vm' -SwitchName 'susentorno''s-internal'",
    );
  });
});

describe('planVmReconciliation', () => {
  it('is a no-op when Running on the correct switch', () => {
    expect(planVmReconciliation('Running', 'susentorno-internal', 'susentorno-internal')).toEqual({
      ok: true,
      stop: false,
      connect: false,
      start: false,
    });
  });

  it('stops, reconnects, and restarts when Running on the wrong switch', () => {
    expect(planVmReconciliation('Running', 'Default Switch', 'susentorno-internal')).toEqual({
      ok: true,
      stop: true,
      connect: true,
      start: true,
    });
  });

  it('reconnects and starts, without stopping, when Off on the wrong switch', () => {
    expect(planVmReconciliation('Off', 'Default Switch', 'susentorno-internal')).toEqual({
      ok: true,
      stop: false,
      connect: true,
      start: true,
    });
  });

  it('only starts when Off on the correct switch', () => {
    expect(planVmReconciliation('Off', 'susentorno-internal', 'susentorno-internal')).toEqual({
      ok: true,
      stop: false,
      connect: false,
      start: true,
    });
  });

  it.each(['Saved', 'Paused', 'Starting', 'Stopping'])(
    'fails with a clear message for state %s rather than guessing',
    (state) => {
      const result = planVmReconciliation(state, 'Default Switch', 'susentorno-internal');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain(state);
    },
  );
});
