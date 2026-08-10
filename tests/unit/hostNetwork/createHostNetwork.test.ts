import { describe, it, expect, vi } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { HostNetworkError } from '../../../src/hostNetwork/hostNetworkError';
import { createHostNetwork } from '../../../src/hostNetwork/createHostNetwork';

const NAT_ALIAS = 'vEthernet (Default Switch)';
const HOMEDIR = 'C:\\Users\\me';

function queuedExec(responses: Array<{ exitCode: number; stdout: string }>): {
  exec: PowerShellExec;
  calls: string[];
} {
  const calls: string[] = [];
  const queue = [...responses];
  return {
    exec: {
      async run(command: string) {
        calls.push(command);
        return queue.shift() ?? { exitCode: 0, stdout: '' };
      },
    },
    calls,
  };
}

// Keyed by the exact adapter alias string, matching how
// resolveForwardListenAddress looks interfaces up (interfaces[adapterName] —
// an exact key lookup, not a scan), unlike detectTakenRanges which only
// cares about the values.
const natInterfaces = {
  [NAT_ALIAS]: [
    {
      address: '10.0.75.1',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: null,
    },
  ],
} as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

describe('createHostNetwork', () => {
  it('creates a fresh switch, IP, and rules when the switch does not exist, using the prompted subnet', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '' }, // Get-VMSwitch: not found
      { exitCode: 0, stdout: '' }, // New-VMSwitch
      { exitCode: 0, stdout: '' }, // New-NetIPAddress
      { exitCode: 0, stdout: '0,0' }, // stale-name cleanup: 0 removed, 0 failed
      { exitCode: 0, stdout: '0,0' }, // stale Query User cleanup: 0 removed, 0 failed
      { exitCode: 0, stdout: '' }, // create Envoy rule
      { exitCode: 0, stdout: '' }, // create DNS rule
      { exitCode: 0, stdout: '' }, // create DHCP rule
      { exitCode: 0, stdout: '' }, // create SMB rule (internal)
      { exitCode: 0, stdout: '' }, // create SMB rule (NAT)
    ]);
    const promptSubnet = vi.fn().mockResolvedValue(67);

    const result = await createHostNetwork({
      exec,
      natAdapterAlias: NAT_ALIAS,
      homedir: HOMEDIR,
      networkInterfaces: natInterfaces,
      promptSubnet,
    });

    expect(result).toEqual({ hostIp: '192.168.67.1', refreshedOnly: false });
    expect(promptSubnet).toHaveBeenCalledWith(expect.any(Array), 0);
    expect(calls[1]).toContain('New-VMSwitch');
    expect(calls[2]).toContain(
      "New-NetIPAddress -InterfaceAlias 'vEthernet (susentorno-internal)' -IPAddress '192.168.67.1'",
    );
  });

  it('uses --subnet directly, skipping the prompt', async () => {
    const { exec } = queuedExec([
      { exitCode: 0, stdout: '' }, // Get-VMSwitch: not found
      { exitCode: 0, stdout: '' }, // New-VMSwitch
      { exitCode: 0, stdout: '' }, // New-NetIPAddress
      { exitCode: 0, stdout: '0,0' }, // stale-name cleanup
      { exitCode: 0, stdout: '0,0' }, // stale Query User cleanup
      { exitCode: 0, stdout: '' }, // create Envoy rule
      { exitCode: 0, stdout: '' }, // create DNS rule
      { exitCode: 0, stdout: '' }, // create DHCP rule
      { exitCode: 0, stdout: '' }, // create SMB rule (internal)
      { exitCode: 0, stdout: '' }, // create SMB rule (NAT)
    ]);
    const promptSubnet = vi.fn();

    const result = await createHostNetwork({
      exec,
      subnet: 80,
      natAdapterAlias: NAT_ALIAS,
      homedir: HOMEDIR,
      networkInterfaces: natInterfaces,
      promptSubnet,
    });

    expect(result.hostIp).toBe('192.168.80.1');
    expect(promptSubnet).not.toHaveBeenCalled();
  });

  it('rejects a taken --subnet without touching Hyper-V', async () => {
    const { exec, calls } = queuedExec([{ exitCode: 0, stdout: '' }]);
    const takenInterfaces = {
      ...natInterfaces,
      SomeOtherAdapter: [
        {
          address: '192.168.80.5',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: 'x',
          internal: false,
          cidr: null,
        },
      ],
    } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

    await expect(
      createHostNetwork({
        exec,
        subnet: 80,
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: takenInterfaces,
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow(HostNetworkError);
    expect(calls.some((c) => c.includes('New-VMSwitch'))).toBe(false);
  });

  it('refreshes firewall rules only when the switch already exists, skipping switch/IP creation and the prompt', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '{"Name":"susentorno-internal"}' }, // Get-VMSwitch: found
      { exitCode: 0, stdout: '0,0' }, // stale-name cleanup
      { exitCode: 0, stdout: '0,0' }, // stale Query User cleanup
      { exitCode: 0, stdout: '' }, // create Envoy rule
      { exitCode: 0, stdout: '' }, // create DNS rule
      { exitCode: 0, stdout: '' }, // create DHCP rule
      { exitCode: 0, stdout: '' }, // create SMB rule (internal)
      { exitCode: 0, stdout: '' }, // create SMB rule (NAT)
    ]);
    const promptSubnet = vi.fn();
    const existingInterfaces = {
      ...natInterfaces,
      'vEthernet (susentorno-internal)': [
        {
          address: '192.168.67.1',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: 'x',
          internal: false,
          cidr: null,
        },
      ],
    } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

    const result = await createHostNetwork({
      exec,
      natAdapterAlias: NAT_ALIAS,
      homedir: HOMEDIR,
      networkInterfaces: existingInterfaces,
      promptSubnet,
    });

    expect(result).toEqual({ hostIp: '192.168.67.1', refreshedOnly: true });
    expect(promptSubnet).not.toHaveBeenCalled();
    expect(calls.some((c) => c.includes('New-VMSwitch'))).toBe(false);
    expect(calls.some((c) => c.includes('New-NetIPAddress'))).toBe(false);
  });

  it('fails if the existing switch has no resolvable IPv4', async () => {
    const { exec } = queuedExec([{ exitCode: 0, stdout: '{"Name":"susentorno-internal"}' }]);

    await expect(
      createHostNetwork({
        exec,
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: natInterfaces, // no susentorno-internal adapter present
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow(HostNetworkError);
  });

  it('fails before touching Hyper-V if the NAT adapter has no resolvable IPv4', async () => {
    const { exec, calls } = queuedExec([]);

    await expect(
      createHostNetwork({
        exec,
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: {},
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow(HostNetworkError);
    // Regression guard: NAT resolution must run before the first PowerShell
    // call (Get-VMSwitch) — this is the one thing this design promises
    // happens "before touching Hyper-V at all." If it ever moved after
    // Get-VMSwitch, calls would be length 1, not 0.
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid isolation name before doing anything', async () => {
    const { exec, calls } = queuedExec([]);

    await expect(
      createHostNetwork({
        exec,
        isolationName: '*',
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: natInterfaces,
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow(HostNetworkError);
    expect(calls).toHaveLength(0);
  });

  it('propagates a mutation failure as HostNetworkError', async () => {
    const { exec } = queuedExec([
      { exitCode: 0, stdout: '' },
      { exitCode: 1, stdout: 'ERROR: switch already exists on the underlying vSwitch layer' },
    ]);

    await expect(
      createHostNetwork({
        exec,
        subnet: 67,
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: natInterfaces,
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow('switch already exists on the underlying vSwitch layer');
  });

  it('fails if stale-name cleanup reports a rule that could not be removed, without creating new rules', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '' }, // Get-VMSwitch: not found
      { exitCode: 0, stdout: '' }, // New-VMSwitch
      { exitCode: 0, stdout: '' }, // New-NetIPAddress
      { exitCode: 0, stdout: '2,1' }, // stale-name cleanup: 1 rule could not be removed
    ]);

    await expect(
      createHostNetwork({
        exec,
        subnet: 67,
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: natInterfaces,
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow(HostNetworkError);
    // A leftover stale rule with the same DisplayName would make the next
    // New-NetFirewallRule call create a duplicate, not a clean replacement —
    // so creation must stop here rather than proceeding.
    expect(calls.some((c) => c.includes('New-NetFirewallRule'))).toBe(false);
  });
});
