import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { runPreflightChecks } from '../../../src/guestSetup/preflightChecks';

function fakeExec(responses: Record<string, string>): PowerShellExec {
  return {
    async run(command: string) {
      for (const [substring, stdout] of Object.entries(responses)) {
        if (command.includes(substring)) return { exitCode: 0, stdout };
      }
      return { exitCode: 0, stdout: '' };
    },
  };
}

const ready = {
  "Get-VM -Name 'my-vm'": '{"Name":"my-vm","State":"Running"}',
  "Get-VMNetworkAdapter -VMName 'my-vm'": '{"SwitchName":"Default Switch","IPAddresses":[]}',
  "Get-VMSwitch -Name 'susentorno-internal'": '{"Name":"susentorno-internal"}',
  "Get-VMSwitch -Name 'Default Switch'": '{"Name":"Default Switch"}',
  '-LocalPort 67': 'bound',
  '-LocalPort 53': 'bound',
};

const baseOpts = {
  vmName: 'my-vm',
  internalAdapterAlias: 'vEthernet (susentorno-internal)',
  internalSwitchName: 'susentorno-internal',
  natAdapterAlias: 'vEthernet (Default Switch)',
  internalSwitchHostIp: '192.168.67.1',
};

describe('runPreflightChecks', () => {
  it('succeeds and returns the derived NAT switch name when everything checks out', async () => {
    const result = await runPreflightChecks({ ...baseOpts, exec: fakeExec(ready) });
    expect(result).toEqual({ ok: true, defaultSwitchName: 'Default Switch' });
  });

  it('fails on a malformed NAT adapter alias before touching the VM', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      natAdapterAlias: 'Ethernet',
      exec: fakeExec(ready),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Ethernet');
  });

  it('fails when no VM matches the name exactly', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, "Get-VM -Name 'my-vm'": '' }),
    });
    expect(result.ok).toBe(false);
  });

  it('fails when the VM has more than one network adapter', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({
        ...ready,
        "Get-VMNetworkAdapter -VMName 'my-vm'":
          '[{"SwitchName":"Default Switch","IPAddresses":[]},{"SwitchName":"susentorno-internal","IPAddresses":[]}]',
      }),
    });
    expect(result.ok).toBe(false);
  });

  it('fails when the VM has zero network adapters', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, "Get-VMNetworkAdapter -VMName 'my-vm'": '' }),
    });
    expect(result.ok).toBe(false);
  });

  it('fails when the internal switch does not exist, without claiming the name was derived', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, "Get-VMSwitch -Name 'susentorno-internal'": '' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Internal switch 'susentorno-internal'");
      expect(result.message).not.toContain('derived');
    }
  });

  it('fails when the derived NAT switch does not resolve to a real switch', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, "Get-VMSwitch -Name 'Default Switch'": '' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("derived switch name 'Default Switch'");
  });

  it('fails when run-hosting is not listening on the internal-switch host IP', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, '-LocalPort 67': '' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('run-hosting');
  });
});
