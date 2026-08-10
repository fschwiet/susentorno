import { describe, it, expect } from 'vitest';
import { HostNetworkError } from '../../../src/hostNetwork/hostNetworkError';
import { resolveHostNetworkNames } from '../../../src/hostNetwork/hostNetworkNames';

describe('resolveHostNetworkNames', () => {
  it('uses the fixed default names when no isolation name is given', () => {
    expect(resolveHostNetworkNames()).toEqual({
      switchName: 'susentorno-internal',
      adapterAlias: 'vEthernet (susentorno-internal)',
      envoyRuleName: 'susentorno Envoy Proxy (VM inbound)',
      dnsRuleName: 'susentorno DNS stub (VM inbound)',
      dhcpRuleName: 'susentorno DHCP (VM inbound)',
      smbRuleName: 'susentorno share (VM inbound)',
    });
  });

  it('splices the isolation name into every derived name', () => {
    expect(resolveHostNetworkNames('test')).toEqual({
      switchName: 'susentorno-test-internal',
      adapterAlias: 'vEthernet (susentorno-test-internal)',
      envoyRuleName: 'susentorno-test Envoy Proxy (VM inbound)',
      dnsRuleName: 'susentorno-test DNS stub (VM inbound)',
      dhcpRuleName: 'susentorno-test DHCP (VM inbound)',
      smbRuleName: 'susentorno-test share (VM inbound)',
    });
  });

  it('accepts letters, digits, and hyphens', () => {
    expect(() => resolveHostNetworkNames('ci-Run-42')).not.toThrow();
  });

  it.each(['*', '?', '[a]', 'a b', "a'b", 'a;b', ''])(
    'rejects an isolation name containing %j',
    (bad) => {
      expect(() => resolveHostNetworkNames(bad)).toThrow(HostNetworkError);
    },
  );
});
