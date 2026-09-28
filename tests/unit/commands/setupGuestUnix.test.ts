import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerSetupGuestUnix } from '../../../src/commands/setupGuestUnix';

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
