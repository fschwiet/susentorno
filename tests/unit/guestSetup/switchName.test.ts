import { describe, it, expect } from 'vitest';
import { deriveSwitchName } from '../../../src/guestSetup/switchName';

describe('deriveSwitchName', () => {
  it('strips the vEthernet ( ) wrapper', () => {
    expect(deriveSwitchName('vEthernet (susentorno-internal)')).toBe('susentorno-internal');
  });

  it('handles a switch name containing spaces', () => {
    expect(deriveSwitchName('vEthernet (Default Switch)')).toBe('Default Switch');
  });

  it('returns null for an alias that is not a vEthernet adapter alias', () => {
    expect(deriveSwitchName('Ethernet')).toBeNull();
  });

  it('returns null for an unclosed alias', () => {
    expect(deriveSwitchName('vEthernet (susentorno-internal')).toBeNull();
  });
});
