import { describe, expect, it } from 'vitest';
import { filterCandidateAddresses } from '../../guest/hyperv/testGuest';

describe('filterCandidateAddresses', () => {
  const internal = { address: '192.168.68.1', netmask: '255.255.255.0' };
  it('keeps ordered IPv4 addresses in the expected subnet only', () => {
    expect(
      filterCandidateAddresses(
        ['172.28.144.31', '192.168.68.9', 'fe80::1', '192.168.68.42'],
        internal,
      ),
    ).toEqual(['192.168.68.9', '192.168.68.42']);
  });
  it('returns no candidates for stale, malformed, or not-yet-reported addresses', () => {
    expect(
      filterCandidateAddresses(['', 'not-an-ip', '192.168.68.999', '172.28.144.31'], internal),
    ).toEqual([]);
    expect(filterCandidateAddresses([], internal)).toEqual([]);
  });
  it('honours non-/24 masks', () => {
    expect(
      filterCandidateAddresses(['192.168.68.42', '192.168.68.200'], {
        address: '192.168.68.1',
        netmask: '255.255.255.128',
      }),
    ).toEqual(['192.168.68.42']);
  });
});
