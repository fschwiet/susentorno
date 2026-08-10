import { describe, it, expect } from 'vitest';
import {
  buildNewVmSwitchCommand,
  buildNewNetIpAddressCommand,
  buildRemoveVmSwitchCommand,
  buildGetVmNetworkAdaptersOnSwitchCommand,
  parseAttachedVms,
  parseVmSwitchExistsExact,
} from '../../../src/hostNetwork/hostNetworkSwitchOps';

describe('buildNewVmSwitchCommand', () => {
  it('creates an Internal switch with the given name, quoted', () => {
    const command = buildNewVmSwitchCommand("susentorno's-internal");
    expect(command).toContain("New-VMSwitch -Name 'susentorno''s-internal' -SwitchType Internal");
    expect(command).toContain('-ErrorAction Stop');
    expect(command).toContain('catch { Write-Output "ERROR:');
  });
});

describe('buildNewNetIpAddressCommand', () => {
  it('assigns a /24 IPv4 address to the given interface, quoted', () => {
    const command = buildNewNetIpAddressCommand('vEthernet (susentorno-internal)', '192.168.67.1');
    expect(command).toContain(
      "New-NetIPAddress -InterfaceAlias 'vEthernet (susentorno-internal)' -IPAddress '192.168.67.1' -PrefixLength 24",
    );
    expect(command).toContain('-ErrorAction Stop');
  });
});

describe('buildRemoveVmSwitchCommand', () => {
  it('removes the switch by name, quoted, non-interactively', () => {
    const command = buildRemoveVmSwitchCommand('susentorno-test-internal');
    expect(command).toContain("Remove-VMSwitch -Name 'susentorno-test-internal'");
    expect(command).toContain('-Force');
    expect(command).toContain('-ErrorAction Stop');
  });
});

describe('buildGetVmNetworkAdaptersOnSwitchCommand', () => {
  it('filters VM network adapters by switch name, quoted', () => {
    const command = buildGetVmNetworkAdaptersOnSwitchCommand("susentorno's-internal");
    expect(command).toContain('Get-VMNetworkAdapter -All');
    expect(command).toContain("-eq 'susentorno''s-internal'");
    expect(command).toContain('ConvertTo-Json -Compress');
  });
});

describe('parseAttachedVms', () => {
  it('returns an empty array for empty stdout', () => {
    expect(parseAttachedVms('')).toEqual([]);
  });

  it('parses a single VM', () => {
    expect(parseAttachedVms('{"VMName":"my-vm"}')).toEqual([{ vmName: 'my-vm' }]);
  });

  it('parses multiple VMs', () => {
    const stdout = '[{"VMName":"vm-a"},{"VMName":"vm-b"}]';
    expect(parseAttachedVms(stdout)).toEqual([{ vmName: 'vm-a' }, { vmName: 'vm-b' }]);
  });
});

describe('parseVmSwitchExistsExact', () => {
  it('is true when the returned Name matches exactly', () => {
    expect(parseVmSwitchExistsExact('{"Name":"susentorno-internal"}', 'susentorno-internal')).toBe(
      true,
    );
  });

  it('is false for empty stdout', () => {
    expect(parseVmSwitchExistsExact('', 'susentorno-internal')).toBe(false);
  });

  it('is false when the returned Name does not match exactly, even if non-empty', () => {
    expect(
      parseVmSwitchExistsExact('{"Name":"susentorno-internal-old"}', 'susentorno-internal'),
    ).toBe(false);
  });
});
