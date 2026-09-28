import { describe, it, expect } from 'vitest';
import { WindowsGuestError } from '../../../../src/guestSetup/windows/guestExecutor';
import {
  runWindowsSetup,
  POWERSHELL_DIRECT_READY_DEADLINE_MS,
  WINDOWS_OFF_CONFIRM_TIMEOUT_MS,
  WINDOWS_STOP_TIMEOUT_MS,
  type WindowsSetupDeps,
  type WindowsSetupFlags,
  type WindowsSetupOutcome,
} from '../../../../src/guestSetup/windows/setupFlow';
import {
  HOST_CONTEXT,
  authRejection,
  fakeClock,
  fakeExecutors,
  fakeHyperV,
  guestOk,
  scriptedPrompts,
  structuralChecksBehavior,
  type EventLog,
  type FakeHyperV,
  type GuestBehavior,
} from './flowFakes';

const GUEST_PASSWORD = 'guest-pw-Zx81';
const OTHER_PASSWORD = 'other-pw-Qq42';

interface Harness {
  outcome: WindowsSetupOutcome;
  out: string[];
  events: EventLog;
  hyperV: FakeHyperV;
  asked: ReturnType<typeof scriptedPrompts>['asked'];
  executors: ReturnType<typeof fakeExecutors>;
  clock: ReturnType<typeof fakeClock>;
}

async function run(
  options: {
    flags?: WindowsSetupFlags;
    answers?: Record<string, string[] | 'hang' | 'cancel'>;
    vm?: Partial<FakeHyperV['state']>;
    hyperV?: Parameters<typeof fakeHyperV>[1];
    guest?: GuestBehavior;
    signal?: AbortSignal;
  } = {},
): Promise<Harness> {
  const events: EventLog = [];
  const hyperV = fakeHyperV(options.vm, { events, ...options.hyperV });
  const { prompts, asked } = scriptedPrompts(
    options.answers ?? {
      'Hyper-V VM name': ['win-dev'],
      'SMB share name': [''],
      'Guest username': ['Administrator'],
      'Guest password': [GUEST_PASSWORD],
    },
    events,
  );
  const executors = fakeExecutors(options.guest ?? structuralChecksBehavior());
  const clock = fakeClock();
  const out: string[] = [];
  const deps: WindowsSetupDeps = {
    exec: hyperV.exec,
    createExecutor: (opts) => executors.create(opts),
    prompts,
    out: (line) => {
      out.push(line);
      events.push(`out:${line}`);
    },
    clock,
    context: HOST_CONTEXT,
  };
  const outcome = await runWindowsSetup(
    deps,
    options.flags ?? {},
    options.signal ?? new AbortController().signal,
  );
  return { outcome, out, events, hyperV, asked, executors, clock };
}

const announcements = (out: string[]): string[] =>
  out
    .filter((line) => /^setup-guest-windows: [HG]\d+ .*\.\.\.$/.test(line))
    .map((line) => /^setup-guest-windows: ([HG]\d+) /.exec(line)![1]);

function expectFailure(outcome: WindowsSetupOutcome) {
  if (outcome.kind !== 'failure')
    throw new Error(`expected a failure, got ${JSON.stringify(outcome)}`);
  return outcome;
}

describe('runWindowsSetup: the happy path through G3', () => {
  it('runs the phases in order and then fails plainly because later phases are not implemented', async () => {
    const { outcome, out } = await run();
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('G4');
    expect(failure.error.kind).toBe('not-implemented');
    expect(failure.error.message).toContain('not implemented');
    expect(failure.error.message).toContain("'win-dev'");
    expect(failure.vmName).toBe('win-dev');
    expect(announcements(out)).toEqual(['H1', 'H2', 'H3', 'G1', 'G2', 'G3']);
  });

  it('announces each phase as `setup-guest-windows: <phase>...`', async () => {
    const { out } = await run();
    expect(out).toContain('setup-guest-windows: H1 host prerequisites and answers...');
    expect(out).toContain('setup-guest-windows: H2 host checks...');
    expect(out).toContain('setup-guest-windows: H3 guest credentials...');
    expect(out).toContain("setup-guest-windows: G1 reconciling 'win-dev' to 'Default Switch'...");
    expect(out).toContain("setup-guest-windows: G2 waiting for PowerShell Direct on 'win-dev'...");
    expect(out).toContain('setup-guest-windows: G3 guest structural checks...');
  });

  it('prompts in the documented order, with the share name defaulting to vm-shared-windows', async () => {
    const { asked } = await run();
    expect(asked.map((a) => `${a.kind}:${a.question}`)).toEqual([
      'text:Hyper-V VM name',
      'text:SMB share name',
      'text:Guest username',
      'masked:Guest password',
    ]);
    expect(asked[1].defaultValue).toBe('vm-shared-windows');
  });

  it('asks every prompt before the first change to the VM', async () => {
    const { events } = await run({ vm: { vmState: 'Off' } });
    const lastPrompt = events.lastIndexOf('prompt:Guest password');
    const firstMutation = events.findIndex((e) =>
      /^host:(Stop-VM|Connect-VMNetworkAdapter|Start-VM)/.test(e),
    );
    expect(lastPrompt).toBeGreaterThanOrEqual(0);
    expect(firstMutation).toBeGreaterThan(lastPrompt);
  });

  it('runs every structural check with a 2 minute deadline', async () => {
    const { executors } = await run();
    const timeouts = executors.created[0].timeouts;
    // The readiness probe, then the five structural checks.
    expect(timeouts.slice(1)).toEqual([120_000, 120_000, 120_000, 120_000, 120_000]);
  });

  it('creates the executor with the guest credential and disposes it on the way out', async () => {
    const { executors } = await run();
    expect(executors.created).toHaveLength(1);
    expect(executors.created[0].vmName).toBe('win-dev');
    expect(executors.created[0].credential).toEqual({
      username: 'Administrator',
      password: GUEST_PASSWORD,
    });
    expect(executors.created[0].disposed).toBe(true);
  });

  it('never prints a password', async () => {
    const { out, outcome } = await run();
    const text = JSON.stringify({ out, outcome });
    expect(text).not.toContain(GUEST_PASSWORD);
  });
});

describe('flag suppression', () => {
  it('asks only for the guest password when every non-secret flag is given', async () => {
    const { asked, outcome } = await run({
      flags: {
        vmName: 'win-dev',
        shareName: 'vm-shared-windows',
        guestUsername: 'Administrator',
        shareAccount: 'susentorno',
      },
      answers: { 'Guest password': [GUEST_PASSWORD] },
    });
    expect(asked.map((a) => a.question)).toEqual(['Guest password']);
    expect(expectFailure(outcome).phase).toBe('G4');
  });

  it('each flag suppresses only its own prompt', async () => {
    const { asked } = await run({
      flags: { vmName: 'win-dev' },
      answers: {
        'SMB share name': ['vm-shared-windows'],
        'Guest username': ['Administrator'],
        'Guest password': [GUEST_PASSWORD],
      },
    });
    expect(asked.map((a) => a.question)).toEqual([
      'SMB share name',
      'Guest username',
      'Guest password',
    ]);
  });

  it('checks the named share, not the default, against the environment', async () => {
    const { hyperV } = await run({
      flags: { shareName: 'custom-share' },
      answers: {
        'Hyper-V VM name': ['win-dev'],
        'Guest username': ['Administrator'],
        'Guest password': [GUEST_PASSWORD],
      },
    });
    expect(hyperV.commands.some((c) => c.includes("Get-SmbShare -Name 'custom-share'"))).toBe(true);
  });
});

describe('H2 host checks', () => {
  it('fails before either guest prompt when the share resolves to another directory', async () => {
    const { outcome, asked } = await run({ hyperV: { sharePath: 'C:\\elsewhere' } });
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('H2');
    expect(failure.error.kind).toBe('host-preflight');
    expect(failure.error.message).toContain('C:\\elsewhere');
    expect(asked.map((a) => a.question)).not.toContain('Guest username');
    expect(asked.map((a) => a.question)).not.toContain('Guest password');
  });

  it('fails before the guest prompts when run-hosting is not listening', async () => {
    const { outcome, asked } = await run({ hyperV: { listeners: false } });
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('H2');
    expect(failure.error.message).toContain('run-hosting');
    expect(asked.map((a) => a.question)).not.toContain('Guest password');
  });

  it.each([
    ['Saved', {}],
    ['Paused', {}],
    ['Starting', {}],
    ['Stopping', {}],
  ])('rejects a %s VM without touching it', async (vmState) => {
    const { outcome, hyperV } = await run({ vm: { vmState } });
    expect(expectFailure(outcome).phase).toBe('H2');
    expect(hyperV.commands.some((c) => /^(Stop|Start)-VM|^Connect-/.test(c))).toBe(false);
  });

  it('rejects a VM with an extra adapter, an unrelated switch, or a disconnected adapter', async () => {
    for (const vm of [{ adapters: 2 }, { switchName: 'External' }, { switchName: null }]) {
      const { outcome, hyperV } = await run({ vm });
      expect(expectFailure(outcome).phase, JSON.stringify(vm)).toBe('H2');
      expect(hyperV.commands.some((c) => /^(Stop|Start)-VM|^Connect-/.test(c))).toBe(false);
    }
  });
});

describe('G1 accepted starting states', () => {
  const mutations = (hyperV: FakeHyperV): string[] =>
    hyperV.commands.filter((c) => /^(Stop-VM|Start-VM|Connect-VMNetworkAdapter)/.test(c));

  it('starts an Off VM that is already on the Default Switch', async () => {
    const { hyperV, outcome } = await run({ vm: { vmState: 'Off', switchName: 'Default Switch' } });
    expect(mutations(hyperV)).toEqual(["Start-VM -Name 'win-dev'"]);
    expect(expectFailure(outcome).phase).toBe('G4');
  });

  it('connects an Off VM on the Internal switch to the Default Switch, then starts it', async () => {
    const { hyperV } = await run({ vm: { vmState: 'Off', switchName: 'susentorno-internal' } });
    expect(mutations(hyperV)).toEqual([
      "Connect-VMNetworkAdapter -VMName 'win-dev' -SwitchName 'Default Switch'",
      "Start-VM -Name 'win-dev'",
    ]);
  });

  it('reuses a VM already running on the Default Switch without restarting it', async () => {
    const { hyperV, outcome, out } = await run({
      vm: { vmState: 'Running', switchName: 'Default Switch' },
    });
    expect(mutations(hyperV)).toEqual([]);
    expect(expectFailure(outcome).phase).toBe('G4');
    expect(out.join('\n')).toContain('reusing');
  });

  it('stops a VM running on the Internal switch, moves it, and starts it', async () => {
    const { hyperV } = await run({ vm: { vmState: 'Running', switchName: 'susentorno-internal' } });
    expect(mutations(hyperV)).toEqual([
      "Stop-VM -Name 'win-dev'",
      "Connect-VMNetworkAdapter -VMName 'win-dev' -SwitchName 'Default Switch'",
      "Start-VM -Name 'win-dev'",
    ]);
  });

  it('gives the graceful stop the Windows deadline and never force-stops', async () => {
    const { hyperV } = await run({ vm: { vmState: 'Running', switchName: 'susentorno-internal' } });
    const stop = hyperV.timeouts.find((t) => t.command.startsWith('Stop-VM'));
    expect(stop?.timeoutMs).toBe(180_000);
    expect(WINDOWS_STOP_TIMEOUT_MS).toBe(180_000);
    expect(WINDOWS_OFF_CONFIRM_TIMEOUT_MS).toBe(60_000);
    expect(hyperV.commands.some((c) => /-Force|-TurnOff/.test(c))).toBe(false);
  });

  it('fails G1 after 60 seconds of confirming Off when the VM never stops, without forcing it', async () => {
    const { outcome, clock, hyperV } = await run({
      vm: { vmState: 'Running', switchName: 'susentorno-internal' },
      hyperV: { stopNeverCompletes: true },
    });
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('G1');
    expect(failure.error.kind).toBe('vm-reconcile');
    expect(failure.error.message).toContain("did not reach 'Off'");
    expect(clock.time).toBeGreaterThanOrEqual(60_000);
    expect(clock.time).toBeLessThan(65_000);
    expect(hyperV.commands.some((c) => /^Start-VM|-Force|-TurnOff/.test(c))).toBe(false);
  });
});

describe('H3 and G2: the guest credential loop', () => {
  it('asks for the username and password again as a pair when the guest rejects the credential', async () => {
    const behavior: GuestBehavior = (script, credential) =>
      credential.password === 'wrong'
        ? authRejection()
        : structuralChecksBehavior()(script, credential);
    const { outcome, executors, asked, hyperV } = await run({
      flags: { guestUsername: 'Administrator' },
      answers: {
        'Hyper-V VM name': ['win-dev'],
        'SMB share name': [''],
        'Guest username': ['Admin2'],
        'Guest password': ['wrong', GUEST_PASSWORD],
      },
      guest: behavior,
      vm: { vmState: 'Off' },
    });
    // The flagged username is asked for again on the second round, along with the password.
    expect(asked.map((a) => `${a.kind}:${a.question}`)).toEqual([
      'text:Hyper-V VM name',
      'text:SMB share name',
      'masked:Guest password',
      'text:Guest username',
      'masked:Guest password',
    ]);
    expect(executors.created.map((e) => e.credential)).toEqual([
      { username: 'Administrator', password: 'wrong' },
      { username: 'Admin2', password: GUEST_PASSWORD },
    ]);
    expect(executors.created.map((e) => e.disposed)).toEqual([true, true]);
    // The VM was reconciled once, not once per attempt.
    expect(hyperV.commands.filter((c) => c.startsWith('Start-VM'))).toHaveLength(1);
    expect(expectFailure(outcome).phase).toBe('G4');
  });

  it('tells the user the credential was rejected without echoing it', async () => {
    const { out } = await run({
      answers: {
        'Hyper-V VM name': ['win-dev'],
        'SMB share name': [''],
        'Guest username': ['Administrator', 'Administrator'],
        'Guest password': [OTHER_PASSWORD, GUEST_PASSWORD],
      },
      guest: (script, credential) =>
        credential.password === OTHER_PASSWORD
          ? authRejection()
          : structuralChecksBehavior()(script, credential),
    });
    const rejected = out.filter((line) => line.includes('rejected'));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("'Administrator'");
    expect(JSON.stringify(out)).not.toContain(OTHER_PASSWORD);
  });

  it('ends cleanly as a cancellation on EOF at the re-asked prompt', async () => {
    const { outcome, executors } = await run({
      answers: {
        'Hyper-V VM name': ['win-dev'],
        'SMB share name': [''],
        'Guest username': ['Administrator'],
        'Guest password': ['wrong'],
      },
      guest: () => authRejection(),
    });
    expect(outcome).toMatchObject({ kind: 'cancelled', reason: 'input-ended', vmName: 'win-dev' });
    expect(executors.created.every((e) => e.disposed)).toBe(true);
  });

  it('ends cleanly as a cancellation on EOF at the first guest prompt', async () => {
    const { outcome, hyperV } = await run({
      answers: { 'Hyper-V VM name': ['win-dev'], 'SMB share name': [''] },
    });
    expect(outcome).toMatchObject({ kind: 'cancelled', reason: 'input-ended', phase: 'H3' });
    expect(hyperV.commands.some((c) => /^(Stop|Start)-VM|^Connect-/.test(c))).toBe(false);
  });

  it('ends cleanly on EOF at the VM name prompt, before a VM exists', async () => {
    const { outcome } = await run({ answers: {} });
    expect(outcome).toEqual({
      kind: 'cancelled',
      phase: 'H1',
      reason: 'input-ended',
      question: 'Hyper-V VM name',
    });
  });
});

describe('structural guest failures', () => {
  it.each([
    [
      'an unsupported platform',
      {
        platform: guestOk(
          JSON.stringify({
            Caption: 'Microsoft Windows 10 Pro',
            Build: '19045',
            EditionId: 'Professional',
            DisplayVersion: '22H2',
            ProcessorArchitecture: 9,
          }),
        ),
      },
    ],
    [
      'a non-administrator',
      {
        admin: guestOk(
          JSON.stringify({ IsLocal: true, Enabled: true, IsAdministratorsMember: false }),
        ),
      },
    ],
    ['a non-elevated token', { elevation: guestOk('False') }],
    [
      'a pending reboot',
      { pending: guestOk(JSON.stringify({ Markers: ['Windows Update\\RebootRequired'] })) },
    ],
    ['a missing WinGet', { winget: guestOk(JSON.stringify({ Found: false })) }],
  ])('fails %s at G3 without asking for the password again', async (_label, overrides) => {
    const { outcome, asked, executors } = await run({ guest: structuralChecksBehavior(overrides) });
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('G3');
    expect(failure.error.kind).toBe('guest-check');
    expect(failure.error.message).toContain("'win-dev'");
    expect(asked.filter((a) => a.question === 'Guest password')).toHaveLength(1);
    expect(executors.created).toHaveLength(1);
    expect(executors.created[0].disposed).toBe(true);
  });

  it('fails a pending reboot with the restart-then-rerun remediation', async () => {
    const { outcome } = await run({
      guest: structuralChecksBehavior({
        pending: guestOk(JSON.stringify({ Markers: ['Windows Update\\RebootRequired'] })),
      }),
    });
    expect(expectFailure(outcome).error.message).toContain('Restart the guest, then rerun.');
  });
});

describe('G2 readiness deadline and heartbeat', () => {
  const notReady = (): GuestBehavior => () =>
    new WindowsGuestError('transport', 'the guest is not ready');

  it('gives up after 5 minutes of fake time with a typed timeout failure', async () => {
    const { outcome, clock } = await run({ guest: notReady() });
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('G2');
    expect(failure.error.kind).toBe('guest-timeout');
    expect(failure.error.message).toContain("'win-dev'");
    expect(POWERSHELL_DIRECT_READY_DEADLINE_MS).toBe(300_000);
    expect(clock.time).toBe(300_000);
  });

  it('prints an elapsed-time heartbeat about every 15 seconds while waiting', async () => {
    const { out } = await run({ guest: notReady() });
    const beats = out.filter((line) => line.includes('still waiting for PowerShell Direct'));
    expect(beats.length).toBeGreaterThanOrEqual(18);
    expect(beats.length).toBeLessThanOrEqual(21);
    expect(beats[0]).toContain('15s elapsed');
    expect(beats[1]).toContain('30s elapsed');
  });

  it('probes about every 5 seconds', async () => {
    const { executors } = await run({ guest: notReady() });
    expect(executors.created[0].scripts.length).toBeGreaterThanOrEqual(55);
    expect(executors.created[0].scripts.length).toBeLessThanOrEqual(62);
  });

  it('classifies a protocol failure as its own kind and disposes the executor', async () => {
    const { outcome, executors } = await run({
      guest: () => new WindowsGuestError('protocol', 'the bridge misbehaved'),
    });
    const failure = expectFailure(outcome);
    expect(failure.error.kind).toBe('guest-protocol');
    expect(failure.phase).toBe('G2');
    expect(executors.created[0].disposed).toBe(true);
  });
});

describe('cancellation', () => {
  it('returns a cancelled outcome when interrupted at a prompt', async () => {
    const controller = new AbortController();
    const pending = run({
      answers: { 'Hyper-V VM name': 'hang' },
      signal: controller.signal,
    });
    controller.abort();
    const { outcome } = await pending;
    expect(outcome).toEqual({ kind: 'cancelled', phase: 'H1', reason: 'interrupt' });
  });

  it('returns a cancelled outcome, with the VM name, when interrupted at the guest password prompt', async () => {
    const controller = new AbortController();
    const pending = run({
      answers: {
        'Hyper-V VM name': ['win-dev'],
        'SMB share name': [''],
        'Guest username': ['Administrator'],
        'Guest password': 'hang',
      },
      signal: controller.signal,
    });
    // Let the flow reach the password prompt before interrupting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const { outcome } = await pending;
    expect(outcome).toEqual({
      kind: 'cancelled',
      phase: 'H3',
      reason: 'interrupt',
      vmName: 'win-dev',
    });
  });

  it('aborts the in-flight guest invocation, returns cancelled, and disposes the executor', async () => {
    const controller = new AbortController();
    const seenSignals: (AbortSignal | undefined)[] = [];
    const events: EventLog = [];
    const hyperV = fakeHyperV({}, { events });
    const { prompts } = scriptedPrompts({
      'Hyper-V VM name': ['win-dev'],
      'SMB share name': [''],
      'Guest username': ['Administrator'],
      'Guest password': [GUEST_PASSWORD],
    });
    const created: { disposed: boolean }[] = [];
    const outcome = await runWindowsSetup(
      {
        exec: hyperV.exec,
        prompts,
        out: () => {},
        clock: fakeClock(),
        context: HOST_CONTEXT,
        createExecutor: ({ vmName }) => {
          const record = { disposed: false };
          created.push(record);
          return {
            vmName,
            invoke: (_script, options) => {
              seenSignals.push(options.signal);
              // The first invocation is the readiness probe; Ctrl+C arrives while it is in flight.
              return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () =>
                  reject(new WindowsGuestError('cancelled', 'The invocation was cancelled.')),
                );
                controller.abort();
              });
            },
            async dispose() {
              record.disposed = true;
            },
          };
        },
      },
      {},
      controller.signal,
    );
    expect(outcome).toEqual({
      kind: 'cancelled',
      phase: 'G2',
      reason: 'interrupt',
      vmName: 'win-dev',
    });
    expect(seenSignals[0]).toBe(controller.signal);
    expect(created.map((c) => c.disposed)).toEqual([true]);
  });

  it('reports a signal that is already aborted as cancelled without prompting', async () => {
    const controller = new AbortController();
    controller.abort();
    const { outcome, asked } = await run({ signal: controller.signal });
    expect(outcome).toMatchObject({ kind: 'cancelled', reason: 'interrupt' });
    expect(asked).toEqual([]);
  });
});

describe('Ctrl+C typed at a prompt', () => {
  it('is an interrupt, not a dead input, at the VM name prompt', async () => {
    const { outcome } = await run({ answers: { 'Hyper-V VM name': 'cancel' } });
    expect(outcome).toEqual({
      kind: 'cancelled',
      phase: 'H1',
      reason: 'interrupt',
      question: 'Hyper-V VM name',
    });
  });

  it('is an interrupt at the guest password prompt, carrying the VM name', async () => {
    const { outcome } = await run({
      answers: {
        'Hyper-V VM name': ['win-dev'],
        'SMB share name': [''],
        'Guest username': ['Administrator'],
        'Guest password': 'cancel',
      },
    });
    expect(outcome).toEqual({
      kind: 'cancelled',
      phase: 'H3',
      reason: 'interrupt',
      vmName: 'win-dev',
    });
  });
});

describe('unexpected errors', () => {
  it('turns an unexpected throw into a classified failure and still disposes the executor', async () => {
    const { outcome, executors } = await run({
      guest: () => {
        throw new TypeError('kaboom');
      },
    });
    const failure = expectFailure(outcome);
    expect(failure.error.kind).toBe('unexpected');
    expect(failure.error.message).toContain('kaboom');
    expect(executors.created[0].disposed).toBe(true);
  });
});
