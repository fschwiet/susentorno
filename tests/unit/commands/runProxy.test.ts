import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerRunProxy } from '../../../src/commands/runProxy';

describe('registerRunProxy', () => {
  it('no longer exposes --forward-ports', () => {
    const program = new Command();
    registerRunProxy(program);
    const runProxyCommand = program.commands.find((cmd) => cmd.name() === 'run-proxy');
    expect(runProxyCommand).toBeDefined();
    const flags = runProxyCommand!.options.map((opt) => opt.flags);
    expect(flags.some((f) => f.includes('--forward-ports'))).toBe(false);
  });
});
