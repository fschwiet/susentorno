import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerRunHosting } from '../../../src/commands/runHosting';

describe('run-hosting command option surface', () => {
  it('no longer exposes --forward-ports', () => {
    const program = new Command();
    registerRunHosting(program);
    const runHostingCommand = program.commands.find((cmd) => cmd.name() === 'run-hosting');
    expect(runHostingCommand).toBeDefined();
    const flags = runHostingCommand!.options.map((opt) => opt.flags);
    expect(flags.some((f) => f.includes('--forward-ports'))).toBe(false);
  });
});
