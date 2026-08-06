import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerRemountGuestShare } from '../../../src/commands/remountGuestShare';

describe('remount-guest-share command option surface', () => {
  it('registers the command with an adapter-alias option defaulting to the internal switch', () => {
    const program = new Command();
    registerRemountGuestShare(program);
    const command = program.commands.find((cmd) => cmd.name() === 'remount-guest-share');
    expect(command).toBeDefined();

    const adapterOption = command!.options.find((o) => o.flags.includes('--adapter-alias'));
    expect(adapterOption?.defaultValue).toBe('vEthernet (susentorno-internal)');
  });
});
