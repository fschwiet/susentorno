import { describe, it, expect } from 'vitest';
import { ipToInt, intToIp, networkAddress, prefixLength } from '../../../src/runProxy/ip';
describe('IPv4 helpers', () => {
  it('round-trips addresses and uses unsigned integers', () => { for (const ip of ['0.0.0.0', '192.168.67.1', '10.0.0.255', '255.255.255.255']) expect(intToIp(ipToInt(ip))).toBe(ip); expect(ipToInt('255.255.255.255')).toBe(4294967295); });
  it('calculates network addresses', () => { expect(intToIp(networkAddress('192.168.67.1', '255.255.255.0'))).toBe('192.168.67.0'); expect(intToIp(networkAddress('172.17.224.36', '255.255.240.0'))).toBe('172.17.224.0'); });
  it('counts prefix bits', () => { expect(prefixLength('255.255.255.0')).toBe(24); expect(prefixLength('255.255.240.0')).toBe(20); expect(prefixLength('255.0.0.0')).toBe(8); });
});
