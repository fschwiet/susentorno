import { describe, it, expect } from 'vitest';
import { createLeaseTable } from '../../src/runHosting/dhcpLeases';
const make = (o = {}) =>
  createLeaseTable({ hostIp: '192.168.67.1', netmask: '255.255.255.0', leaseSeconds: 3600, ...o });
describe('DHCP lease table', () => {
  it('allocates stable in-pool leases and resolves collisions', () => {
    const t = make({ poolStart: 10, poolEnd: 11 });
    const a = t.acquire('a');
    const b = t.acquire('b');
    expect(a).toMatch(/^192\.168\.67\.(10|11)$/);
    expect(b).not.toBe(a);
    expect(t.acquire('a')).toBe(a);
  });
  it('returns null when exhausted and reuses expired leases', () => {
    let now = 1000;
    const t = make({ poolStart: 10, poolEnd: 10, leaseSeconds: 60, now: () => now });
    expect(t.acquire('a')).toBe('192.168.67.10');
    expect(t.acquire('b')).toBeNull();
    now += 61_000;
    expect(t.acquire('b')).toBe('192.168.67.10');
  });
  it('adjudicates requests, release and decline', () => {
    const t = make({ poolStart: 10, poolEnd: 11 });
    const a = t.acquire('a')!;
    expect(t.request('a', a)).toBe('ack');
    expect(t.request('b', a)).toBe('nak');
    expect(t.request('b', '10.9.9.9')).toBe('nak');
    t.release('a');
    expect(t.request('b', a)).toBe('ack');
    t.decline(a);
    expect(t.request('c', a)).toBe('nak');
  });
});
