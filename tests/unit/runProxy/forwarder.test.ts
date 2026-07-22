import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  DEFAULT_INTERNAL_SWITCH_ADAPTER,
  resolveForwardListenAddress,
} from '../../../src/runProxy/forwarder';

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

describe('resolveForwardListenAddress', () => {
  it('returns the non-internal IPv4 of the named adapter', () => {
    const interfaces = {
      'vEthernet (configamatron-internal)': [ipv4('192.168.67.1')],
      'Wi-Fi': [ipv4('10.0.0.5')],
    };
    expect(resolveForwardListenAddress(DEFAULT_INTERNAL_SWITCH_ADAPTER, interfaces)).toBe(
      '192.168.67.1',
    );
  });

  it('returns null when the adapter is absent', () => {
    expect(
      resolveForwardListenAddress(DEFAULT_INTERNAL_SWITCH_ADAPTER, { 'Wi-Fi': [ipv4('10.0.0.5')] }),
    ).toBeNull();
  });

  it('skips internal and IPv6 addresses', () => {
    const interfaces = {
      'vEthernet (configamatron-internal)': [
        { ...ipv4('127.0.0.1', true) },
        {
          address: 'fe80::1',
          netmask: 'ffff::',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 0,
        } as NetworkInterfaceInfo,
        ipv4('192.168.67.1'),
      ],
    };
    expect(resolveForwardListenAddress(DEFAULT_INTERNAL_SWITCH_ADAPTER, interfaces)).toBe(
      '192.168.67.1',
    );
  });
});
