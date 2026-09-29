import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { endOnEndedPrompt, registerSetupGuestUnix } from '../../../src/commands/setupGuestUnix';
import { PromptEndedError } from '../../../src/cliPrompt';

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

describe('setup-guest-unix when a prompt can no longer be answered', () => {
  const run = async (thrown: unknown) => {
    const lines: string[] = [];
    const exitCodes: number[] = [];
    const action = endOnEndedPrompt(
      async () => {
        throw thrown;
      },
      { err: (line) => lines.push(line), setExitCode: (code) => exitCodes.push(code) },
    );
    await action();
    return { lines, exitCodes };
  };

  it('reports end of input on one line, changes nothing, and exits 1 instead of a stack trace', async () => {
    const { lines, exitCodes } = await run(new PromptEndedError('eof', 'Hyper-V VM name'));
    expect(lines).toEqual([
      "setup-guest-unix: input ended before the 'Hyper-V VM name' prompt was answered; nothing was changed.",
    ]);
    expect(exitCodes).toEqual([1]);
  });

  it('reports a cancelled prompt (Ctrl+C) the same way', async () => {
    const { lines, exitCodes } = await run(new PromptEndedError('cancelled', 'Guest password'));
    expect(lines).toEqual([
      "setup-guest-unix: cancelled at the 'Guest password' prompt; nothing was changed.",
    ]);
    expect(exitCodes).toEqual([1]);
  });

  it('lets every other error escape unchanged', async () => {
    const boom = new Error('boom');
    const action = endOnEndedPrompt(
      async () => {
        throw boom;
      },
      { err: () => {}, setExitCode: () => {} },
    );
    await expect(action()).rejects.toBe(boom);
  });

  it('does nothing when the action completes', async () => {
    const { lines, exitCodes } = await (async () => {
      const seen = { lines: [] as string[], exitCodes: [] as number[] };
      await endOnEndedPrompt(async () => {}, {
        err: (line) => seen.lines.push(line),
        setExitCode: (code) => seen.exitCodes.push(code),
      })();
      return seen;
    })();
    expect(lines).toEqual([]);
    expect(exitCodes).toEqual([]);
  });
});
