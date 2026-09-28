import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { resolveGuestNetwork } from '../../../src/guestSetup/guestNetwork';
import { HostNetworkError } from '../../../src/hostNetwork/hostNetworkNames';

function ipv4(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  };
}

describe('resolveGuestNetwork', () => {
  it('resolves both IPs and both internal names for a named isolation network', () => {
    expect(
      resolveGuestNetwork('test', 'nat-adapter', {
        'vEthernet (susentorno-test-internal)': [ipv4('192.168.68.1')],
        'nat-adapter': [ipv4('172.28.128.1')],
      }),
    ).toEqual({
      internalAdapterAlias: 'vEthernet (susentorno-test-internal)',
      internalSwitchName: 'susentorno-test-internal',
      internalSwitchHostIp: '192.168.68.1',
      defaultSwitchHostIp: '172.28.128.1',
    });
  });

  it('selects the unnamed default network when no isolation name is given', () => {
    expect(
      resolveGuestNetwork(undefined, 'nat-adapter', {
        'vEthernet (susentorno-internal)': [ipv4('192.168.67.1')],
        'nat-adapter': [ipv4('172.28.128.1')],
      }),
    ).toEqual({
      internalAdapterAlias: 'vEthernet (susentorno-internal)',
      internalSwitchName: 'susentorno-internal',
      internalSwitchHostIp: '192.168.67.1',
      defaultSwitchHostIp: '172.28.128.1',
    });
  });

  it('fails on the internal-switch adapter first, pointing at create-host-network', () => {
    expect(
      resolveGuestNetwork('test', 'nat-adapter', { 'nat-adapter': [ipv4('172.28.128.1')] }),
    ).toEqual({
      adapterAlias: 'vEthernet (susentorno-test-internal)',
      hint: "Run 'susentorno create-host-network --isolation-name test' first.",
    });
  });

  it('omits the flag from the hint when no isolation name was given', () => {
    expect(resolveGuestNetwork(undefined, 'nat-adapter', {})).toEqual({
      adapterAlias: 'vEthernet (susentorno-internal)',
      hint: "Run 'susentorno create-host-network' first.",
    });
  });

  it('fails on the NAT adapter when only it is missing', () => {
    expect(
      resolveGuestNetwork(undefined, 'nat-adapter', {
        'vEthernet (susentorno-internal)': [ipv4('192.168.67.1')],
      }),
    ).toEqual({
      adapterAlias: 'nat-adapter',
      hint: 'Pass --nat-adapter-alias, or attach the guest to the Default Switch first.',
    });
  });

  it('throws HostNetworkError for an invalid isolation name', () => {
    expect(() => resolveGuestNetwork('bad name!', 'nat-adapter', {})).toThrow(HostNetworkError);
  });
});
