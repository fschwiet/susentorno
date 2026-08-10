import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { HostNetworkError } from '../../../src/hostNetwork/hostNetworkError';
import {
  detectTakenRanges,
  isSubnetTaken,
  findFreeSubnet,
  validateSubnet,
} from '../../../src/hostNetwork/subnetSelection';

function ipv4(address: string, netmask: string): NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
  } as NetworkInterfaceInfo;
}

describe('detectTakenRanges', () => {
  it('reads a /24 address into a network/prefixLength pair', () => {
    const ranges = detectTakenRanges({ Eth0: [ipv4('192.168.67.5', '255.255.255.0')] });
    expect(ranges).toEqual([{ network: ipToInt('192.168.67.0'), prefixLength: 24 }]);
  });

  it('ignores non-IPv4 entries', () => {
    const ranges = detectTakenRanges({
      Eth0: [{ ...ipv4('192.168.67.5', '255.255.255.0'), family: 'IPv6' } as NetworkInterfaceInfo],
    });
    expect(ranges).toEqual([]);
  });

  function ipToInt(ip: string): number {
    const [a, b, c, d] = ip.split('.').map(Number);
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }
});

describe('isSubnetTaken / findFreeSubnet', () => {
  it('reports a /24 taken only at its own third octet', () => {
    const taken = detectTakenRanges({ Eth0: [ipv4('192.168.67.5', '255.255.255.0')] });
    expect(isSubnetTaken(67, taken)).toBe(true);
    expect(isSubnetTaken(68, taken)).toBe(false);
  });

  it('reports every 192.168.n.0/24 taken when a /16 address is present (broader-prefix collision)', () => {
    const taken = detectTakenRanges({ Eth0: [ipv4('192.168.1.10', '255.255.0.0')] });
    expect(isSubnetTaken(0, taken)).toBe(true);
    expect(isSubnetTaken(200, taken)).toBe(true);
  });

  it('finds the lowest free n', () => {
    const taken = detectTakenRanges({
      Eth0: [ipv4('192.168.0.5', '255.255.255.0'), ipv4('192.168.1.5', '255.255.255.0')],
    });
    expect(findFreeSubnet(taken)).toBe(2);
  });

  it('returns null when every n is taken', () => {
    const taken = detectTakenRanges({ Eth0: [ipv4('192.168.1.10', '255.255.0.0')] });
    expect(findFreeSubnet(taken)).toBeNull();
  });
});

describe('validateSubnet', () => {
  it('accepts a free, in-range n', () => {
    expect(() => validateSubnet(67, [])).not.toThrow();
  });

  it('rejects a negative n', () => {
    expect(() => validateSubnet(-1, [])).toThrow(HostNetworkError);
  });

  it('rejects an n above 255', () => {
    expect(() => validateSubnet(256, [])).toThrow(HostNetworkError);
  });

  it('rejects a non-integer n', () => {
    expect(() => validateSubnet(1.5, [])).toThrow(HostNetworkError);
  });

  it('rejects a taken n', () => {
    const taken = detectTakenRanges({ Eth0: [ipv4('192.168.67.5', '255.255.255.0')] });
    expect(() => validateSubnet(67, taken)).toThrow(HostNetworkError);
  });
});
