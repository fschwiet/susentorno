import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { resolveIsolationNetwork } from '../../../src/runHosting/isolationNetwork';
import { createHostNetworkHint, HostNetworkError } from '../../../src/hostNetwork/hostNetworkNames';

function ipv4(address: string, netmask = '255.255.255.0'): NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  };
}

describe('resolveIsolationNetwork', () => {
  it('resolves the named isolation network to its derived adapter, address, and netmask', () => {
    expect(
      resolveIsolationNetwork('test', {
        'vEthernet (susentorno-test-internal)': [ipv4('192.168.68.1')],
        'vEthernet (susentorno-internal)': [ipv4('192.168.67.1')],
      }),
    ).toEqual({
      found: true,
      adapterAlias: 'vEthernet (susentorno-test-internal)',
      address: '192.168.68.1',
      netmask: '255.255.255.0',
    });
  });

  it('falls back to the unnamed default adapter when no isolation name is given', () => {
    expect(
      resolveIsolationNetwork(undefined, {
        'vEthernet (susentorno-internal)': [ipv4('192.168.67.1', '255.255.255.128')],
      }),
    ).toEqual({
      found: true,
      adapterAlias: 'vEthernet (susentorno-internal)',
      address: '192.168.67.1',
      netmask: '255.255.255.128',
    });
  });

  it('reports the alias it looked for when that adapter is absent', () => {
    expect(resolveIsolationNetwork('test', { 'Wi-Fi': [ipv4('10.0.0.5')] })).toEqual({
      found: false,
      adapterAlias: 'vEthernet (susentorno-test-internal)',
    });
  });

  it('reports not-found when the adapter is present with no non-internal IPv4', () => {
    expect(
      resolveIsolationNetwork('test', {
        'vEthernet (susentorno-test-internal)': [
          { ...ipv4('127.0.0.1'), internal: true },
          {
            address: 'fe80::1',
            netmask: 'ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: 'fe80::1/64',
            scopeid: 0,
          } as NetworkInterfaceInfo,
        ],
      }),
    ).toEqual({ found: false, adapterAlias: 'vEthernet (susentorno-test-internal)' });
  });

  it('propagates HostNetworkError for an invalid isolation name', () => {
    expect(() => resolveIsolationNetwork('bad name!', {})).toThrow(HostNetworkError);
    expect(() => resolveIsolationNetwork('bad name!', {})).toThrow(
      'only letters, digits, and hyphens are allowed',
    );
  });
});

describe('createHostNetworkHint', () => {
  it('names the plain command when there is no isolation name', () => {
    expect(createHostNetworkHint()).toBe("Run 'susentorno create-host-network' first.");
  });

  it('echoes the isolation name back so the printed command is the one to run', () => {
    expect(createHostNetworkHint('test')).toBe(
      "Run 'susentorno create-host-network --isolation-name test' first.",
    );
  });
});
