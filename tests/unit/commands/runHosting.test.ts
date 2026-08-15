import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerRunHosting } from '../../../src/commands/runHosting';

describe('run-hosting command option surface', () => {
  it('exposes neither --forward-ports nor --forward-listen, and does expose --isolation-name', () => {
    const program = new Command();
    registerRunHosting(program);
    const runHostingCommand = program.commands.find((cmd) => cmd.name() === 'run-hosting');
    expect(runHostingCommand).toBeDefined();
    const flags = runHostingCommand!.options.map((opt) => opt.flags);
    expect(flags.some((f) => f.includes('--forward-ports'))).toBe(false);
    expect(flags.some((f) => f.includes('--forward-listen'))).toBe(false);
    expect(flags.some((f) => f.includes('--isolation-name'))).toBe(true);
    // --no-forward is unchanged by the isolation-name work.
    expect(flags.some((f) => f.includes('--no-forward'))).toBe(true);
  });

  it('exposes --skip-allow-list', () => {
    const program = new Command();
    registerRunHosting(program);
    const command = program.commands.find((cmd) => cmd.name() === 'run-hosting');
    expect(command?.options.some((option) => option.flags.includes('--skip-allow-list'))).toBe(
      true,
    );
  });
});
