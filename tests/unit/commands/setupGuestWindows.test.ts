import { describe, it, expect } from 'vitest';
import { Command, CommanderError } from 'commander';
import { EventEmitter } from 'node:events';
import type { NetworkInterfaceInfo } from 'node:os';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import {
  executeSetupGuestWindows,
  exitCodeForOutcome,
  registerSetupGuestWindows,
  type SetupGuestWindowsEnvironment,
} from '../../../src/commands/setupGuestWindows';
import type { WindowsSetupOutcome } from '../../../src/guestSetup/windows/setupFlow';
import {
  authRejection,
  fakeClock,
  fakeExecutors,
  fakeHyperV,
  guestOk,
  scriptedPrompts,
  shareGuest,
  structuralChecksBehavior,
  readProxyCaPem,
  discoverFlowStepPlans,
  stepFilenameOf,
} from '../guestSetup/windows/flowFakes';

function commandOf(): Command {
  const program = new Command();
  registerSetupGuestWindows(program);
  return program.commands.find((cmd) => cmd.name() === 'setup-guest-windows')!;
}

describe('setup-guest-windows command registration', () => {
  it('exposes every non-secret option and no password option', () => {
    const flags = commandOf().options.map((o) => o.flags);
    for (const flag of [
      '--isolation-name',
      '--nat-adapter-alias',
      '--vm-name',
      '--guest-username',
      '--share-name',
      '--share-account',
    ]) {
      expect(
        flags.some((f) => f.startsWith(flag)),
        flag,
      ).toBe(true);
    }
    expect(flags.some((f) => /password/i.test(f))).toBe(false);
    expect(flags.some((f) => f.includes('--guest-address'))).toBe(false);
  });

  it('defaults only the NAT adapter alias, so an absent share flag still prompts', () => {
    const options = commandOf().options;
    expect(options.find((o) => o.flags.includes('--nat-adapter-alias'))?.defaultValue).toBe(
      'vEthernet (Default Switch)',
    );
    for (const flag of ['--vm-name', '--guest-username', '--share-name', '--share-account']) {
      expect(options.find((o) => o.flags.includes(flag))?.defaultValue, flag).toBeUndefined();
    }
  });

  it.each(['--guest-password', '--share-password'])('rejects %s as an unknown option', (flag) => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerSetupGuestWindows(program);
    try {
      program.parse(['node', 'susentorno', 'setup-guest-windows', flag, 'secret']);
      throw new Error('expected the option to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(CommanderError);
      expect((error as CommanderError).code).toBe('commander.unknownOption');
    }
  });

  it('describes PowerShell Direct, the switch move, both phases, elevation, and run-hosting', () => {
    const help = commandOf().description().replace(/\s+/g, ' ');
    for (const phrase of [
      'PowerShell Direct',
      'from the Default Switch to the selected Internal switch',
      'pre-isolation',
      'post-isolation',
      'elevated (Administrator)',
      'susentorno run-hosting',
    ]) {
      expect(help, phrase).toContain(phrase);
    }
  });
});

describe('exitCodeForOutcome', () => {
  it('maps success to 0, failure to 1, and cancellation to 130', () => {
    const failure: WindowsSetupOutcome = {
      kind: 'failure',
      phase: 'G3',
      error: { kind: 'guest-check', message: 'x' },
    };
    const cancelled: WindowsSetupOutcome = { kind: 'cancelled', phase: 'H1', reason: 'interrupt' };
    expect(exitCodeForOutcome({ kind: 'success' })).toBe(0);
    expect(exitCodeForOutcome(failure)).toBe(1);
    expect(exitCodeForOutcome(cancelled)).toBe(130);
  });
});

const v4 = (address: string): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal: false }) as NetworkInterfaceInfo;

const CWD = 'C:\\work\\project';
const SHARE = 'C:\\work\\project\\.susentorno\\vm-shared-windows';

function environment(
  overrides: {
    elevated?: boolean;
    answers?: Parameters<typeof scriptedPrompts>[0];
    existing?: string[];
    guest?: Parameters<typeof fakeExecutors>[0];
    hyperV?: ReturnType<typeof fakeHyperV>;
    plans?: () => ReturnType<typeof discoverFlowStepPlans>;
  } = {},
) {
  const hyperV = overrides.hyperV ?? fakeHyperV();
  const elevated = overrides.elevated ?? true;
  const exec: PowerShellExec = {
    async run(command, opts) {
      if (command.includes('IsInRole')) {
        return { exitCode: 0, stdout: elevated ? 'True' : 'False' };
      }
      return hyperV.exec.run(command, opts);
    },
  };
  const { prompts } = scriptedPrompts(
    overrides.answers ?? {
      'Hyper-V VM name': ['win-dev'],
      'SMB share name': [''],
      'Guest username': ['Administrator'],
      'Guest password': ['pw'],
      'VM share account': ['susentorno'],
      'VM share password': ['share-pw'],
    },
  );
  const executors = fakeExecutors(overrides.guest ?? structuralChecksBehavior());
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const interrupts = new EventEmitter();
  const reads: string[] = [];
  const existing = overrides.existing ?? ['C:\\work\\project\\.susentorno', SHARE];
  const env: SetupGuestWindowsEnvironment = {
    exec,
    cwd: CWD,
    prompts,
    createExecutor: (options) => executors.create(options),
    clock: fakeClock(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    interrupts,
    exit: (code) => exits.push(code),
    exists: (path) => existing.includes(path),
    discoverStepPlans: () => (overrides.plans ?? discoverFlowStepPlans)(),
    readFile: (path) => {
      reads.push(path);
      return readProxyCaPem();
    },
    interfaces: {
      'vEthernet (susentorno-internal)': [v4('192.168.67.1')],
      'vEthernet (Default Switch)': [v4('172.29.240.1')],
    },
  };
  return { env, out, err, exits, interrupts, executors, hyperV, reads };
}

const defaultOptions = { natAdapterAlias: 'vEthernet (Default Switch)' };

describe('executeSetupGuestWindows', () => {
  it('fails a non-elevated host first, printing only that, with exit code 1', async () => {
    const { env, err, out, hyperV } = environment({ elevated: false });
    const code = await executeSetupGuestWindows(defaultOptions, env);
    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(
      /^setup-guest-windows: this command requires an elevated \(Administrator\)/,
    );
    expect(out).toEqual([]);
    expect(hyperV.commands).toEqual([]);
  });

  it('fails a missing environment before any prompt', async () => {
    const { env, err, out } = environment({ existing: [] });
    const code = await executeSetupGuestWindows(defaultOptions, env);
    expect(code).toBe(1);
    expect(err[0]).toContain("run 'susentorno init' first");
    expect(out).toEqual([]);
  });

  it('prints a failure with its phase, its classification, and the residual-state footer, and exits 1', async () => {
    const { env, err } = environment({
      hyperV: fakeHyperV({ vmState: 'Running', switchName: 'Default Switch' }),
    });
    const code = await executeSetupGuestWindows(defaultOptions, env);
    expect(code).toBe(1);
    const text = err.join('\n');
    expect(text).toContain(
      'setup-guest-windows: failed in phase G7 isolation gate [not-implemented]',
    );
    expect(text).toContain('setup-guest-windows: residual state');
    expect(text).toContain("VM 'win-dev': Running, attached to 'Default Switch'");
    expect(text).toContain("Rerun 'susentorno setup-guest-windows'");
    expect(text).not.toContain('pw');
  });

  it("reconciles trust from the Windows VM share's cert.pem", async () => {
    const { env, reads } = environment({ hyperV: fakeHyperV({ vmState: 'Running' }) });
    await executeSetupGuestWindows(defaultOptions, env);
    expect(reads).toEqual([`${SHARE}\\cert.pem`]);
  });

  it('shows in the footer which VM share credentials this run kept verified and which it removed', async () => {
    const kept = environment({ hyperV: fakeHyperV({ vmState: 'Running' }) });
    await executeSetupGuestWindows(defaultOptions, kept.env);
    expect(kept.err).toContain(
      '  VM share credential for Default Switch host address 172.29.240.1: verified, kept',
    );

    const removed = environment({
      hyperV: fakeHyperV({ vmState: 'Running' }),
      guest: structuralChecksBehavior(
        {},
        shareGuest({
          override: {
            verify: guestOk(
              JSON.stringify({ Outcome: 'writable', Stage: 'probe', ProbeRemoved: true }),
            ),
          },
        }),
      ),
    });
    const code = await executeSetupGuestWindows(defaultOptions, removed.env);
    expect(code).toBe(1);
    const text = removed.err.join('\n');
    expect(text).toContain('failed in phase G4 VM share credentials [share-credential]');
    expect(text).toContain(
      '  VM share credential for Default Switch host address 172.29.240.1: removed (written by this run but never verified)',
    );
    expect(text).not.toContain('share-pw');
  });

  it('queries Hyper-V for the footer after the failure rather than inferring the state', async () => {
    const hyperV = fakeHyperV({ vmState: 'Off', switchName: 'Default Switch' });
    const { env, err } = environment({ hyperV });
    await executeSetupGuestWindows(defaultOptions, env);
    // The run started the VM; the footer reports what Hyper-V says afterwards.
    expect(err.join('\n')).toContain("VM 'win-dev': Running");
    const lastQueries = hyperV.commands.slice(-2);
    expect(lastQueries[0]).toMatch(/^Get-VM -Name/);
    expect(lastQueries[1]).toMatch(/^Get-VMNetworkAdapter/);
  });

  it('prints a failed step by phase and filename with its captured output, then the footer, and exits 1', async () => {
    const inner = structuralChecksBehavior();
    const { env, err, out } = environment({
      hyperV: fakeHyperV({ vmState: 'Running' }),
      guest: (script, credential) =>
        stepFilenameOf(script) === '02-install-pnpm.ps1'
          ? { exitCode: 3, stdout: '', stderr: 'pnpm failed loudly', timedOut: false }
          : inner(script, credential),
    });
    const code = await executeSetupGuestWindows(defaultOptions, env);
    expect(code).toBe(1);
    const text = err.join('\n');
    expect(text).toContain(
      'setup-guest-windows: failed in phase G6 pre-isolation steps at step 02-install-pnpm.ps1 [step-exit]',
    );
    expect(text).toContain('  Failed step: 02-install-pnpm.ps1');
    expect(text).toContain(
      '  VM share credential for Default Switch host address 172.29.240.1: verified, kept',
    );
    expect(out).toContain('  pnpm failed loudly');
  });

  it('fails a malformed step plan before any password prompt, exits 1, and never touches the VM', async () => {
    const { env, err, hyperV } = environment({
      plans: () => ({ ok: false, message: "exactly one 'configure-network' step" }),
    });
    const code = await executeSetupGuestWindows(defaultOptions, env);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('failed in phase H2 host checks [step-plan]');
    expect(hyperV.commands.some((c) => /^(Start|Stop)-VM/.test(c))).toBe(false);
  });

  it('exits 130 with the footer on a cancellation', async () => {
    const { env, err } = environment({
      answers: {
        'Hyper-V VM name': ['win-dev'],
        'SMB share name': [''],
        'Guest username': ['Administrator'],
        'Guest password': 'cancel',
      },
    });
    const code = await executeSetupGuestWindows(defaultOptions, env);
    expect(code).toBe(130);
    expect(err.join('\n')).toContain('setup-guest-windows: cancelled.');
    expect(err.join('\n')).toContain('setup-guest-windows: residual state');
  });

  it('ends cleanly with 130 on EOF at the VM name prompt, saying so and that nothing changed', async () => {
    const { env, err, hyperV } = environment({ answers: {} });
    const code = await executeSetupGuestWindows(defaultOptions, env);
    expect(code).toBe(130);
    const text = err.join('\n');
    expect(text).toContain("input ended at the 'Hyper-V VM name' prompt");
    expect(text).toContain('No VM was chosen, so nothing was changed.');
    expect(hyperV.commands).toEqual([]);
  });

  it('cancels the run on the first SIGINT and exits immediately on the second', async () => {
    const { env, err, exits, interrupts } = environment({
      answers: { 'Hyper-V VM name': 'hang' },
    });
    const running = executeSetupGuestWindows(defaultOptions, env);
    await new Promise((resolve) => setTimeout(resolve, 10));
    interrupts.emit('SIGINT');
    expect(await running).toBe(130);
    expect(err.join('\n')).toContain('Ctrl+C received');
    // A second Ctrl+C during a stuck cleanup would have exited at once.
    const stuck = environment({ answers: { 'Hyper-V VM name': 'hang' } });
    const second = executeSetupGuestWindows(defaultOptions, stuck.env);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stuck.interrupts.emit('SIGINT');
    stuck.interrupts.emit('SIGINT');
    expect(stuck.exits).toEqual([130]);
    await second;
    expect(exits).toEqual([]);
  });

  it('stops listening for SIGINT once the run is over', async () => {
    const { env, interrupts } = environment();
    await executeSetupGuestWindows(defaultOptions, env);
    expect(interrupts.listenerCount('SIGINT')).toBe(0);
  });

  it('re-asks the guest credential as a pair and then continues', async () => {
    const inner = structuralChecksBehavior();
    const { env, executors } = environment({
      answers: {
        'Hyper-V VM name': ['win-dev'],
        'SMB share name': [''],
        'Guest username': ['Administrator', 'Administrator'],
        'Guest password': ['bad', 'good'],
        'VM share account': ['susentorno'],
        'VM share password': ['share-pw'],
      },
      guest: (script, credential) =>
        credential.password === 'bad' ? authRejection() : inner(script, credential),
    });
    const code = await executeSetupGuestWindows(defaultOptions, env);
    expect(code).toBe(1); // stops at the not-yet-implemented G7
    expect(executors.created).toHaveLength(2);
  });
});
