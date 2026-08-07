import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import {
  buildGetVmCommand,
  parseGetVmResult,
  buildGetVmNetworkAdapterCommand,
  parseVmNetworkAdapterResult,
  buildGetVmSwitchCommand,
  parseVmSwitchExists,
  getVmIpAddresses,
} from '../../../src/guestSetup/hyperVQueries';

describe('buildGetVmCommand', () => {
  it('quotes the VM name and requests a compact JSON object with Name and stringified State', () => {
    const command = buildGetVmCommand("temp'vm");
    expect(command).toContain("Get-VM -Name 'temp''vm'");
    expect(command).toContain('ConvertTo-Json -Compress');
    expect(command).toContain('$_.State.ToString()');
  });
});

describe('parseGetVmResult', () => {
  it('returns null for empty stdout (VM not found)', () => {
    expect(parseGetVmResult('', 'my-vm')).toBeNull();
    expect(parseGetVmResult('   ', 'my-vm')).toBeNull();
  });

  it('parses a single-object result', () => {
    expect(parseGetVmResult('{"Name":"my-vm","State":"Running"}', 'my-vm')).toEqual({
      name: 'my-vm',
      state: 'Running',
    });
  });

  it('picks the one exact match out of a wildcard-expanded array', () => {
    const stdout = '[{"Name":"my-vm","State":"Off"},{"Name":"my-vm-2","State":"Off"}]';
    expect(parseGetVmResult(stdout, 'my-vm')).toEqual({ name: 'my-vm', state: 'Off' });
  });

  it('rejects a name that only matches via wildcard expansion, not exactly', () => {
    const stdout = '[{"Name":"my-vm-2","State":"Off"}]';
    expect(parseGetVmResult(stdout, 'my-vm')).toBeNull();
  });

  it('rejects an ambiguous result with more than one exact match', () => {
    const stdout = '[{"Name":"my-vm","State":"Off"},{"Name":"my-vm","State":"Running"}]';
    expect(parseGetVmResult(stdout, 'my-vm')).toBeNull();
  });
});

describe('buildGetVmNetworkAdapterCommand', () => {
  it('quotes the VM name and requests SwitchName and IPAddresses', () => {
    const command = buildGetVmNetworkAdapterCommand("temp'vm");
    expect(command).toContain("Get-VMNetworkAdapter -VMName 'temp''vm'");
    expect(command).toContain('SwitchName');
    expect(command).toContain('IPAddresses');
  });
});

describe('parseVmNetworkAdapterResult', () => {
  it('returns an empty array for zero adapters', () => {
    expect(parseVmNetworkAdapterResult('')).toEqual([]);
  });

  it('parses a single adapter with multiple IP addresses', () => {
    const stdout = '{"SwitchName":"Default Switch","IPAddresses":["10.0.0.5","fe80::1"]}';
    expect(parseVmNetworkAdapterResult(stdout)).toEqual([
      { switchName: 'Default Switch', ipAddresses: ['10.0.0.5', 'fe80::1'] },
    ]);
  });

  it('normalizes a single IP address that PowerShell serialized as a bare string', () => {
    const stdout = '{"SwitchName":"Default Switch","IPAddresses":"10.0.0.5"}';
    expect(parseVmNetworkAdapterResult(stdout)).toEqual([
      { switchName: 'Default Switch', ipAddresses: ['10.0.0.5'] },
    ]);
  });

  it('parses multiple adapters (the too-many-adapters case the caller rejects)', () => {
    const stdout =
      '[{"SwitchName":"Default Switch","IPAddresses":[]},{"SwitchName":"susentorno-internal","IPAddresses":[]}]';
    expect(parseVmNetworkAdapterResult(stdout)).toHaveLength(2);
  });
});

describe('buildGetVmSwitchCommand / parseVmSwitchExists', () => {
  it('reports a switch as existing when stdout is non-empty', () => {
    expect(parseVmSwitchExists('{"Name":"susentorno-internal"}')).toBe(true);
  });

  it('reports a switch as not existing when stdout is empty', () => {
    expect(parseVmSwitchExists('')).toBe(false);
  });

  it('quotes the switch name', () => {
    expect(buildGetVmSwitchCommand("susentorno's-switch")).toContain(
      "Get-VMSwitch -Name 'susentorno''s-switch'",
    );
  });
});

describe('getVmIpAddresses', () => {
  it('flattens every adapter IP into one array', async () => {
    const exec: PowerShellExec = {
      async run() {
        return {
          exitCode: 0,
          stdout: '{"SwitchName":"susentorno-internal","IPAddresses":["192.168.67.50"]}',
        };
      },
    };
    expect(await getVmIpAddresses(exec, 'my-vm')).toEqual(['192.168.67.50']);
  });

  it('returns an empty array when the adapter has no reported address yet', async () => {
    const exec: PowerShellExec = {
      async run() {
        return { exitCode: 0, stdout: '{"SwitchName":"susentorno-internal","IPAddresses":[]}' };
      },
    };
    expect(await getVmIpAddresses(exec, 'my-vm')).toEqual([]);
  });
});
