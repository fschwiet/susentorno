import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import type { NetworkInterfaceInfo } from 'node:os';
import { registerSetupGuestUnix, resolveGuestNetwork } from '../../../src/commands/setupGuestUnix';
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

describe('setup-guest-unix command option surface', () => {
  it('exposes --isolation-name and the five answer flags, and no longer exposes --adapter-alias', () => {
    const program = new Command();
    registerSetupGuestUnix(program);
    const command = program.commands.find((cmd) => cmd.name() === 'setup-guest-unix');
    expect(command).toBeDefined();
    const flags = command!.options.map((o) => o.flags);

    expect(flags.some((f) => f.includes('--adapter-alias'))).toBe(false);
    for (const flag of [
      '--isolation-name',
      '--vm-name',
      '--guest-address',
      '--guest-username',
      '--share-name',
      '--share-account',
    ]) {
      expect(
        flags.some((f) => f.includes(flag)),
        flag,
      ).toBe(true);
    }

    const natAdapterOption = command!.options.find((o) => o.flags.includes('--nat-adapter-alias'));
    expect(natAdapterOption?.defaultValue).toBe('vEthernet (Default Switch)');
  });

  it('gives the share flags no Commander default, so an absent flag still prompts', () => {
    const program = new Command();
    registerSetupGuestUnix(program);
    const command = program.commands.find((cmd) => cmd.name() === 'setup-guest-unix');
    for (const flag of ['--share-name', '--share-account']) {
      expect(
        command!.options.find((o) => o.flags.includes(flag))?.defaultValue,
        flag,
      ).toBeUndefined();
    }
  });
});

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
