import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import type { NetworkInterfaceInfo } from 'node:os';
import { registerSetupGuestUnix, resolveGuestNetwork } from '../../../src/commands/setupGuestUnix';

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

describe('setup-guest-unix command option surface', () => {
  it('registers the command with adapter-alias overrides and sensible defaults', () => {
    const program = new Command();
    registerSetupGuestUnix(program);
    const command = program.commands.find((cmd) => cmd.name() === 'setup-guest-unix');
    expect(command).toBeDefined();

    const adapterOption = command!.options.find((o) => o.flags.includes('--adapter-alias'));
    expect(adapterOption?.defaultValue).toBe('vEthernet (susentorno-internal)');

    const natAdapterOption = command!.options.find((o) => o.flags.includes('--nat-adapter-alias'));
    expect(natAdapterOption?.defaultValue).toBe('vEthernet (Default Switch)');
  });
});

describe('resolveGuestNetwork', () => {
  it('resolves both IPs when both adapters are present', () => {
    const result = resolveGuestNetwork('internal-adapter', 'nat-adapter', {
      'internal-adapter': [ipv4('192.168.67.1')],
      'nat-adapter': [ipv4('172.28.128.1')],
    });
    expect(result).toEqual({
      internalSwitchHostIp: '192.168.67.1',
      defaultSwitchHostIp: '172.28.128.1',
    });
  });

  it('fails on the internal-switch adapter when it is missing, before checking the NAT one', () => {
    const result = resolveGuestNetwork('internal-adapter', 'nat-adapter', {
      'nat-adapter': [ipv4('172.28.128.1')],
    });
    expect(result).toEqual({
      adapterAlias: 'internal-adapter',
      hint: 'Pass --adapter-alias, or complete setup-machine.md first.',
    });
  });

  it('fails on the NAT adapter when only it is missing', () => {
    const result = resolveGuestNetwork('internal-adapter', 'nat-adapter', {
      'internal-adapter': [ipv4('192.168.67.1')],
    });
    expect(result).toEqual({
      adapterAlias: 'nat-adapter',
      hint: 'Pass --nat-adapter-alias, or attach the guest to the Default Switch first.',
    });
  });
});
