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
import type { WindowsStepPlanResult } from '../../../../src/guestSetup/windows/stepPlan';
import {
  HOST_CONTEXT,
  authRejection,
  discoverFlowStepPlans,
  fakeClock,
  fakeExecutors,
  fakeHyperV,
  guestOk,
  scriptedPrompts,
  readProxyCaPem,
  shareGuest,
  structuralChecksBehavior,
  trustGuest,
  FLOW_AMBIENT_ROOT,
  FLOW_PROXY_CA,
  FLOW_STEP_PLANS,
  stepFilenameOf,
  stepLocationOf,
  type EventLog,
  type FakeHyperV,
  type GuestBehavior,
  type ShareGuest,
  type TrustGuest,
} from './flowFakes';

const GUEST_PASSWORD = 'guest-pw-Zx81';
const OTHER_PASSWORD = 'other-pw-Qq42';
const SHARE_PASSWORD = 'share-pw-Lm93';
const WRONG_SHARE_PASSWORD = 'wrong-share-pw-Nn07';
/** The VM share prompts every run that reaches G4 answers, unless a test says otherwise. */
const shareAnswers = (): Record<string, string[]> => ({
  'VM share account': [''],
  'VM share password': [SHARE_PASSWORD],
});

interface Harness {
  outcome: WindowsSetupOutcome;
  out: string[];
  events: EventLog;
  hyperV: FakeHyperV;
  trust: TrustGuest;
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
    share?: ShareGuest;
    trust?: TrustGuest;
    readProxyCaPem?: () => string;
    stepPlans?: WindowsStepPlanResult;
    signal?: AbortSignal;
  } = {},
): Promise<Harness> {
  const events: EventLog = [];
  const hyperV = fakeHyperV(options.vm, { events, ...options.hyperV });
  const { prompts, asked } = scriptedPrompts(
    {
      ...shareAnswers(),
      ...(options.answers ?? {
        'Hyper-V VM name': ['win-dev'],
        'SMB share name': [''],
        'Guest username': ['Administrator'],
        'Guest password': [GUEST_PASSWORD],
      }),
    },
    events,
  );
  const trust = options.trust ?? trustGuest();
  const behavior = options.guest ?? structuralChecksBehavior({}, options.share, trust);
  const executors = fakeExecutors((script, credential) => {
    const operation = /^# susentorno share credential: (\w+)/.exec(script)?.[1];
    if (operation) events.push(`guest:${operation}`);
    return behavior(script, credential);
  });
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
    readProxyCaPem: options.readProxyCaPem ?? readProxyCaPem,
    discoverStepPlans: () => {
      events.push('host:discover-step-plans');
      return options.stepPlans ?? discoverFlowStepPlans();
    },
  };
  const outcome = await runWindowsSetup(
    deps,
    options.flags ?? {},
    options.signal ?? new AbortController().signal,
  );
  return { outcome, out, events, hyperV, trust, asked, executors, clock };
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

describe('runWindowsSetup: the happy path through G5', () => {
  it('runs the phases in order and then fails plainly because later phases are not implemented', async () => {
    const { outcome, out } = await run();
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('G7');
    expect(failure.error.kind).toBe('not-implemented');
    expect(failure.error.message).toContain('not implemented');
    expect(failure.error.message).toContain("'win-dev'");
    expect(failure.vmName).toBe('win-dev');
    expect(announcements(out)).toEqual(['H1', 'H2', 'H3', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
  });

  it('announces each phase as `setup-guest-windows: <phase>...`', async () => {
    const { out } = await run();
    expect(out).toContain('setup-guest-windows: H1 host prerequisites and answers...');
    expect(out).toContain('setup-guest-windows: H2 host checks...');
    expect(out).toContain('setup-guest-windows: H3 guest credentials...');
    expect(out).toContain("setup-guest-windows: G1 reconciling 'win-dev' to 'Default Switch'...");
    expect(out).toContain("setup-guest-windows: G2 waiting for PowerShell Direct on 'win-dev'...");
    expect(out).toContain('setup-guest-windows: G3 guest structural checks...');
    expect(out).toContain('setup-guest-windows: G4 VM share credentials...');
    expect(out).toContain('setup-guest-windows: G5 guest trust reconciliation...');
  });

  it('prompts in the documented order, with the share name defaulting to vm-shared-windows', async () => {
    const { asked } = await run();
    expect(asked.map((a) => `${a.kind}:${a.question}`)).toEqual([
      'text:Hyper-V VM name',
      'text:SMB share name',
      'text:Guest username',
      'masked:Guest password',
      'text:VM share account',
      'masked:VM share password',
    ]);
    expect(asked[1].defaultValue).toBe('vm-shared-windows');
    expect(asked[4].defaultValue).toBe('susentorno');
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
    // The readiness probe, then the five structural checks, then the share operations.
    expect(timeouts.slice(1, 6)).toEqual([120_000, 120_000, 120_000, 120_000, 120_000]);
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
    expect(asked.map((a) => a.question)).toEqual(['Guest password', 'VM share password']);
    expect(expectFailure(outcome).phase).toBe('G7');
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
      'VM share account',
      'VM share password',
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
    expect(expectFailure(outcome).phase).toBe('G7');
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
    expect(expectFailure(outcome).phase).toBe('G7');
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
    const inner = structuralChecksBehavior();
    const behavior: GuestBehavior = (script, credential) =>
      credential.password === 'wrong' ? authRejection() : inner(script, credential);
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
      'text:VM share account',
      'masked:VM share password',
    ]);
    expect(executors.created.map((e) => e.credential)).toEqual([
      { username: 'Administrator', password: 'wrong' },
      { username: 'Admin2', password: GUEST_PASSWORD },
    ]);
    expect(executors.created.map((e) => e.disposed)).toEqual([true, true]);
    // The VM was reconciled once, not once per attempt.
    expect(hyperV.commands.filter((c) => c.startsWith('Start-VM'))).toHaveLength(1);
    expect(expectFailure(outcome).phase).toBe('G7');
  });

  it('tells the user the credential was rejected without echoing it', async () => {
    const inner = structuralChecksBehavior();
    const { out } = await run({
      answers: {
        'Hyper-V VM name': ['win-dev'],
        'SMB share name': [''],
        'Guest username': ['Administrator', 'Administrator'],
        'Guest password': [OTHER_PASSWORD, GUEST_PASSWORD],
      },
      guest: (script, credential) =>
        credential.password === OTHER_PASSWORD ? authRejection() : inner(script, credential),
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

describe('G4: VM share credentials', () => {
  const shareScripts = (executors: ReturnType<typeof fakeExecutors>, operation: string): string[] =>
    executors.created[0].scripts.filter((script) =>
      script.startsWith(`# susentorno share credential: ${operation}`),
    );
  const allowOnly =
    (password: string): NonNullable<ShareGuest['accepts']> =>
    (credential) =>
      credential.password === password;

  it('replaces and verifies the Default-Switch credential with the prompted account, once, over the guest executor', async () => {
    const share = shareGuest();
    const { outcome, executors, out } = await run({ share });
    expect(executors.created).toHaveLength(1);
    expect(shareScripts(executors, 'replace')).toHaveLength(1);
    expect(shareScripts(executors, 'verify')).toHaveLength(1);
    // Keyed by the Default-Switch host address; the Internal-switch entry is a later phase.
    expect([...share.stored.keys()]).toEqual([HOST_CONTEXT.defaultSwitchHostIp]);
    expect(share.stored.get(HOST_CONTEXT.defaultSwitchHostIp)).toEqual({
      account: 'susentorno',
      password: SHARE_PASSWORD,
    });
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('G7');
    expect(failure.error.message).toContain(HOST_CONTEXT.defaultSwitchHostIp);
    expect(out.join('\n')).not.toContain(SHARE_PASSWORD);
  });

  it('gives each share operation its 1 minute deadline', async () => {
    const { executors } = await run();
    // The probe, five checks, then replace and verify.
    expect(executors.created[0].timeouts.slice(6, 8)).toEqual([60_000, 60_000]);
  });

  it('never sends the share password or a cmdkey/net use command to the guest in plain text', async () => {
    const { executors } = await run();
    for (const script of executors.created[0].scripts) {
      expect(script).not.toContain(SHARE_PASSWORD);
      expect(script).not.toMatch(/cmdkey|\/pass:|\bnet use\b/i);
    }
  });

  it('asks every prompt, including the VM share pair, before the first credential is written', async () => {
    const { events } = await run();
    const lastPrompt = events.lastIndexOf('prompt:VM share password');
    const firstWrite = events.indexOf('guest:replace');
    expect(lastPrompt).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeGreaterThan(lastPrompt);
    // No prompt is ever asked after a credential has been written.
    expect(events.slice(firstWrite).filter((e) => e.startsWith('prompt:'))).toEqual([]);
  });

  it('checks the host account and its share access on the host before writing anything to the guest', async () => {
    const { events, hyperV } = await run();
    expect(hyperV.commands.some((c) => c.startsWith("Get-LocalUser -Name 'susentorno'"))).toBe(
      true,
    );
    expect(
      hyperV.commands.some((c) => c.startsWith("Get-SmbShareAccess -Name 'vm-shared-windows'")),
    ).toBe(true);
    expect(events.indexOf('host:Get-SmbShareAccess')).toBeLessThan(events.indexOf('guest:replace'));
  });

  it('keeps the verified credential and closes the open connection when a later phase fails', async () => {
    const share = shareGuest();
    const inner = structuralChecksBehavior({}, share);
    const { outcome, executors } = await run({
      share,
      guest: (script, credential) =>
        stepFilenameOf(script) === '02-install-pnpm.ps1'
          ? { exitCode: 1, stdout: '', stderr: '', timedOut: false }
          : inner(script, credential),
    });
    const cleanup = shareScripts(executors, 'cleanup');
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toContain('Delete = $false');
    expect(cleanup[0]).not.toContain('Delete = $true');
    expect(share.stored.has(HOST_CONTEXT.defaultSwitchHostIp)).toBe(true);
    expect(expectFailure(outcome).credentials).toEqual([
      { role: 'default', hostIp: HOST_CONTEXT.defaultSwitchHostIp, status: 'verified' },
    ]);
    expect(executors.created[0].disposed).toBe(true);
  });

  describe('paired re-prompt on an SMB authentication failure', () => {
    it('asks for the account and password again as a pair, even when the account came from a flag', async () => {
      const share = shareGuest({ accepts: allowOnly(SHARE_PASSWORD) });
      const { outcome, asked, out, executors } = await run({
        share,
        flags: { shareAccount: 'susentorno' },
        hyperV: { localAccounts: ['susentorno', 'susentorno2'] },
        answers: {
          'Hyper-V VM name': ['win-dev'],
          'SMB share name': [''],
          'Guest username': ['Administrator'],
          'Guest password': [GUEST_PASSWORD],
          'VM share account': ['susentorno2'],
          'VM share password': [WRONG_SHARE_PASSWORD, SHARE_PASSWORD],
        },
      });
      expect(asked.map((a) => `${a.kind}:${a.question}`).slice(4)).toEqual([
        'masked:VM share password',
        'text:VM share account',
        'masked:VM share password',
      ]);
      expect(shareScripts(executors, 'replace')).toHaveLength(2);
      expect(share.stored.get(HOST_CONTEXT.defaultSwitchHostIp)).toEqual({
        account: 'susentorno2',
        password: SHARE_PASSWORD,
      });
      const rejected = out.filter((line) => line.includes('could not authenticate'));
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toContain("'susentorno'");
      expect(JSON.stringify({ out, outcome })).not.toContain(WRONG_SHARE_PASSWORD);
      expect(expectFailure(outcome).phase).toBe('G7');
      expect(expectFailure(outcome).credentials).toEqual([
        { role: 'default', hostIp: HOST_CONTEXT.defaultSwitchHostIp, status: 'verified' },
      ]);
    });

    it('does not prompt for the guest credential again', async () => {
      const share = shareGuest({ accepts: allowOnly(SHARE_PASSWORD) });
      const { asked, executors } = await run({
        share,
        answers: {
          'Hyper-V VM name': ['win-dev'],
          'SMB share name': [''],
          'Guest username': ['Administrator'],
          'Guest password': [GUEST_PASSWORD],
          'VM share account': ['susentorno', 'susentorno'],
          'VM share password': [WRONG_SHARE_PASSWORD, SHARE_PASSWORD],
        },
      });
      expect(asked.filter((a) => a.question === 'Guest password')).toHaveLength(1);
      expect(executors.created).toHaveLength(1);
    });

    it('ends cleanly as a cancellation on EOF at the re-asked prompt and removes the unverified entry', async () => {
      const share = shareGuest({ accepts: allowOnly(SHARE_PASSWORD) });
      const { outcome, executors } = await run({
        share,
        answers: {
          'Hyper-V VM name': ['win-dev'],
          'SMB share name': [''],
          'Guest username': ['Administrator'],
          'Guest password': [GUEST_PASSWORD],
          'VM share account': ['susentorno'],
          'VM share password': [WRONG_SHARE_PASSWORD],
        },
      });
      expect(outcome).toMatchObject({
        kind: 'cancelled',
        reason: 'input-ended',
        phase: 'G4',
        vmName: 'win-dev',
        credentials: [
          { role: 'default', hostIp: HOST_CONTEXT.defaultSwitchHostIp, status: 'removed' },
        ],
      });
      expect(share.stored.size).toBe(0);
      expect(shareScripts(executors, 'cleanup')[0]).toContain('Delete = $true');
      expect(executors.created[0].disposed).toBe(true);
    });

    it('treats Ctrl+C at the share password prompt as an interrupt', async () => {
      const { outcome } = await run({
        answers: {
          'Hyper-V VM name': ['win-dev'],
          'SMB share name': [''],
          'Guest username': ['Administrator'],
          'Guest password': [GUEST_PASSWORD],
          'VM share account': ['susentorno'],
          'VM share password': 'cancel',
        },
      });
      expect(outcome).toMatchObject({ kind: 'cancelled', reason: 'interrupt', phase: 'G4' });
    });
  });

  describe('structural failures never re-prompt', () => {
    it.each([
      [
        'a writable share',
        { Outcome: 'writable', Stage: 'probe', ProbeRemoved: true },
        /can write/,
      ],
      [
        'missing generated content',
        { Outcome: 'error', Stage: 'read', Win32: 2, Message: 'not found' },
        /missing or empty/,
      ],
      [
        'a wrong share path',
        { Outcome: 'error', Stage: 'read', Win32: 67, Message: 'name not found' },
        /could not reach/,
      ],
      [
        'a denied share permission',
        { Outcome: 'error', Stage: 'list-pre-scripts', Win32: 5, Message: 'denied' },
        /denied read access/,
      ],
      [
        'an SMB identity conflict on the same address',
        { Outcome: 'error', Stage: 'read', Win32: 1219, Message: 'multiple connections' },
        /only one identity per server address/,
      ],
    ])(
      'fails %s at G4 with a remediation, one password prompt, and cleanup',
      async (_label, verdict, message) => {
        const share = shareGuest({ override: { verify: guestOk(JSON.stringify(verdict)) } });
        const { outcome, asked, executors } = await run({ share });
        const failure = expectFailure(outcome);
        expect(failure.phase).toBe('G4');
        expect(failure.error.kind).toBe('share-credential');
        expect(failure.error.message).toMatch(message);
        expect(failure.error.message).toContain(HOST_CONTEXT.defaultSwitchHostIp);
        expect(asked.filter((a) => a.question === 'VM share password')).toHaveLength(1);
        expect(asked.filter((a) => a.question === 'VM share account')).toHaveLength(1);
        expect(failure.credentials).toEqual([
          { role: 'default', hostIp: HOST_CONTEXT.defaultSwitchHostIp, status: 'removed' },
        ]);
        expect(share.stored.size).toBe(0);
        expect(executors.created[0].disposed).toBe(true);
      },
    );

    it('fails a missing host account before writing anything to the guest, with the account named', async () => {
      const { outcome, asked, executors } = await run({ hyperV: { localAccounts: [] } });
      const failure = expectFailure(outcome);
      expect(failure.phase).toBe('G4');
      expect(failure.error.kind).toBe('share-account');
      expect(failure.error.message).toContain("'susentorno'");
      expect(failure.error.message).toContain('--share-account');
      expect(asked.filter((a) => a.question === 'VM share password')).toHaveLength(1);
      expect(shareScripts(executors, 'replace')).toEqual([]);
      expect(failure.credentials).toBeUndefined();
    });

    it('fails a share that does not grant the account read access', async () => {
      const { outcome, executors } = await run({ hyperV: { shareGrantsRead: false } });
      const failure = expectFailure(outcome);
      expect(failure.error.kind).toBe('share-account');
      expect(failure.error.message).toContain('read access');
      expect(shareScripts(executors, 'replace')).toEqual([]);
    });
  });

  describe('cleanup after a handled failure or cancellation', () => {
    it('records a removal that could not be done, and still disposes the executor', async () => {
      const inner = structuralChecksBehavior();
      const { outcome, executors } = await run({
        guest: (script, credential) =>
          /^# susentorno share credential: (verify|cleanup)/.test(script)
            ? new WindowsGuestError('transport', 'the guest went away')
            : inner(script, credential),
      });
      const failure = expectFailure(outcome);
      expect(failure.error.kind).toBe('guest-transport');
      expect(failure.credentials).toEqual([
        { role: 'default', hostIp: HOST_CONTEXT.defaultSwitchHostIp, status: 'removal-failed' },
      ]);
      expect(executors.created[0].disposed).toBe(true);
    });

    it('removes the unverified entry when the run is cancelled mid-verification', async () => {
      const share = shareGuest();
      const inner = structuralChecksBehavior({}, share);
      const { outcome, executors } = await run({
        guest: (script, credential) =>
          script.startsWith('# susentorno share credential: verify')
            ? new WindowsGuestError('cancelled', 'The invocation was cancelled.')
            : inner(script, credential),
      });
      expect(outcome).toMatchObject({
        kind: 'cancelled',
        phase: 'G4',
        reason: 'interrupt',
        credentials: [
          { role: 'default', hostIp: HOST_CONTEXT.defaultSwitchHostIp, status: 'removed' },
        ],
      });
      expect(share.stored.size).toBe(0);
      expect(executors.created[0].disposed).toBe(true);
    });

    it('runs cleanup without the flow signal, so an aborted run can still clean up', async () => {
      const controller = new AbortController();
      const seen: (AbortSignal | undefined)[] = [];
      const share = shareGuest();
      const events: EventLog = [];
      const hyperV = fakeHyperV({}, { events });
      const { prompts } = scriptedPrompts({
        'Hyper-V VM name': ['win-dev'],
        'SMB share name': [''],
        'Guest username': ['Administrator'],
        'Guest password': [GUEST_PASSWORD],
        ...shareAnswers(),
      });
      const behavior = structuralChecksBehavior({}, share);
      const outcome = await runWindowsSetup(
        {
          exec: hyperV.exec,
          prompts,
          out: () => {},
          clock: fakeClock(),
          context: HOST_CONTEXT,
          readProxyCaPem,
          discoverStepPlans: discoverFlowStepPlans,
          createExecutor: ({ vmName, credential }) => ({
            vmName,
            async invoke(script, options) {
              if (script.startsWith('# susentorno share credential:')) {
                seen.push(options.signal);
                // Ctrl+C arrives while the share credential is being replaced.
                if (script.startsWith('# susentorno share credential: replace')) controller.abort();
              }
              const result = behavior(script, credential);
              if (result instanceof Error) throw result;
              return result;
            },
            async dispose() {},
          }),
        },
        {},
        controller.signal,
      );
      expect(outcome).toMatchObject({ kind: 'cancelled', reason: 'interrupt', phase: 'G4' });
      expect(seen[0]).toBe(controller.signal);
      // The cleanup request is the last one, and it carries no signal.
      expect(seen[seen.length - 1]).toBeUndefined();
      expect(share.stored.size).toBe(0);
    });
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
        readProxyCaPem,
        discoverStepPlans: discoverFlowStepPlans,
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

describe('G5 guest trust reconciliation', () => {
  const trustOperations = (executors: ReturnType<typeof fakeExecutors>): string[] =>
    executors.created
      .flatMap((e) => e.scripts)
      .map((script) => /^# susentorno trust: ([\w-]+)/.exec(script)?.[1])
      .filter((operation): operation is string => operation !== undefined);

  it('runs its scripts through the credential-scoped executor after the share verification', async () => {
    const { executors } = await run();
    const scripts = executors.created[0].scripts;
    const verifyAt = scripts.findIndex((s) =>
      s.startsWith('# susentorno share credential: verify'),
    );
    const inspectAt = scripts.findIndex((s) => s.startsWith('# susentorno trust: inspect'));
    expect(verifyAt).toBeGreaterThanOrEqual(0);
    expect(inspectAt).toBeGreaterThan(verifyAt);
    expect(executors.created[0].credential.password).toBe(GUEST_PASSWORD);
  });

  it('propagates the host roots and the environment proxy CA into the guest store', async () => {
    const { trust } = await run();
    expect(trust.roots).toEqual(
      expect.arrayContaining([FLOW_AMBIENT_ROOT.sha256, FLOW_PROXY_CA.sha256]),
    );
  });

  it('reports progress as G5 lines with counts and abbreviated fingerprints only', async () => {
    const { out } = await run();
    const lines = out.filter((line) => line.startsWith('setup-guest-windows: G5 '));
    expect(lines.length).toBeGreaterThan(1);
    const text = lines.join('\n');
    expect(text).toContain(FLOW_PROXY_CA.sha256.slice(0, 12));
    expect(text).not.toContain(FLOW_PROXY_CA.sha256);
    expect(text).not.toContain('BEGIN CERTIFICATE');
    expect(text).not.toContain('flow-proxy-ca');
  });

  it('a G5 failure stops the run before every step, keeps the verified credential, and names the operation', async () => {
    const { outcome, out, executors } = await run({
      trust: trustGuest({
        override: {
          'import-proxy': guestOk(
            JSON.stringify({
              Outcome: 'error',
              Fingerprint: FLOW_PROXY_CA.sha256,
              Message: 'Access denied',
            }),
          ),
        },
      }),
    });
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('G5');
    expect(failure.error.kind).toBe('guest-trust');
    expect(failure.error.message).toContain('proxy import');
    expect(failure.error.message).toContain(FLOW_PROXY_CA.sha256.slice(0, 12));
    expect(failure.error.message).not.toContain(FLOW_PROXY_CA.sha256);
    // no later phase started: G6 (the pre-isolation steps) never ran
    expect(announcements(out)).toEqual(['H1', 'H2', 'H3', 'G1', 'G2', 'G3', 'G4', 'G5']);
    // the trust operations stopped at the failure
    expect(trustOperations(executors)).toEqual([
      'inspect',
      'write-ambient-pems',
      'import-ambient',
      'import-proxy',
    ]);
    expect(failure.credentials).toEqual([
      { role: 'default', hostIp: HOST_CONTEXT.defaultSwitchHostIp, status: 'verified' },
    ]);
    expect(executors.created[0].disposed).toBe(true);
  });

  it('fails at G5 when the host cannot enumerate its roots', async () => {
    const { outcome, executors } = await run({ hyperV: { hostRootsFail: true } });
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('G5');
    expect(failure.error.kind).toBe('guest-trust');
    expect(failure.error.message).toContain('host enumeration');
    expect(trustOperations(executors)).toEqual([]);
  });

  it('fails at G5 when the environment cert.pem cannot be read', async () => {
    const { outcome, executors } = await run({
      readProxyCaPem: () => {
        throw new Error("ENOENT: no such file or directory, open 'cert.pem'");
      },
    });
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('G5');
    expect(failure.error.kind).toBe('guest-trust');
    expect(failure.error.message).toContain('cert.pem');
    expect(trustOperations(executors)).toEqual([]);
  });

  it('reports a Ctrl+C during trust reconciliation as a cancellation in G5', async () => {
    const inner = structuralChecksBehavior();
    const controller = new AbortController();
    const { outcome } = await run({
      signal: controller.signal,
      guest: (script, credential) => {
        if (script.startsWith('# susentorno trust: inspect')) {
          controller.abort();
          return new WindowsGuestError('cancelled', 'cancelled');
        }
        return inner(script, credential);
      },
    });
    expect(outcome).toMatchObject({ kind: 'cancelled', phase: 'G5', reason: 'interrupt' });
  });
});

describe('H2 step plans', () => {
  it('fails a malformed generated plan before either password prompt, with no VM or guest change', async () => {
    const { outcome, asked, executors, hyperV } = await run({
      stepPlans: {
        ok: false,
        message: "The generated pre-scripts must contain exactly one 'configure-network' step",
      },
    });
    const failure = expectFailure(outcome);
    expect(failure.phase).toBe('H2');
    expect(failure.error.kind).toBe('step-plan');
    expect(failure.error.message).toContain('configure-network');
    expect(asked.map((a) => a.question)).toEqual(['Hyper-V VM name', 'SMB share name']);
    expect(executors.created).toEqual([]);
    expect(hyperV.commands.some((c) => /^(Stop|Start)-VM|^Connect-VMNetworkAdapter/.test(c))).toBe(
      false,
    );
  });

  it('discovers the plans in H2, after the host checks and before the guest prompts', async () => {
    const { events } = await run();
    const discovered = events.indexOf('host:discover-step-plans');
    expect(discovered).toBeGreaterThan(
      events.indexOf('out:setup-guest-windows: H2 host checks...'),
    );
    expect(discovered).toBeLessThan(events.indexOf('prompt:Guest username'));
  });
});

describe('G6 pre-isolation steps', () => {
  const stepsRun = (executors: ReturnType<typeof fakeExecutors>): string[] =>
    executors.created
      .flatMap((e) => e.scripts)
      .map(stepFilenameOf)
      .filter((name): name is string => name !== undefined);

  const failingStep =
    (
      filename: string,
      result: ReturnType<typeof guestOk> | Error,
      inner: GuestBehavior = structuralChecksBehavior(),
    ): GuestBehavior =>
    (script, credential) =>
      stepFilenameOf(script) === filename ? result : inner(script, credential);

  it('runs every pre-isolation step, in order, after trust reconciliation and from the Default Switch share', async () => {
    const { executors } = await run();
    const scripts = executors.created[0].scripts;
    expect(stepsRun(executors)).toEqual(FLOW_STEP_PLANS.pre.map((s) => s.filename));
    const lastTrust = scripts.map((s) => /^# susentorno trust:/.test(s)).lastIndexOf(true);
    const firstStep = scripts.findIndex((s) => stepFilenameOf(s) !== undefined);
    expect(firstStep).toBeGreaterThan(lastTrust);
    for (const script of scripts.filter((s) => stepFilenameOf(s) !== undefined)) {
      expect(stepLocationOf(script)).toEqual({
        hostIp: HOST_CONTEXT.defaultSwitchHostIp,
        directory: 'pre-scripts',
      });
    }
  });

  it('gives configure-network the Internal-switch host IP and no other step any argument', async () => {
    const { executors } = await run();
    const withIp = executors.created[0].scripts.filter((s) => s.includes('-HostIp'));
    expect(withIp.map(stepFilenameOf)).toEqual(['03-configure-network.ps1']);
    expect(withIp[0]).toContain(Buffer.from(HOST_CONTEXT.internalSwitchHostIp).toString('base64'));
  });

  it('announces G6 and each step by phase and filename', async () => {
    const { out } = await run();
    expect(out).toContain('setup-guest-windows: G6 pre-isolation steps...');
    expect(out).toContain(
      'setup-guest-windows: G6 running step pre-scripts/01-install-packages.ps1 (1 of 3)',
    );
  });

  it('gives every step the 30 minute deadline', async () => {
    const { executors } = await run();
    const { scripts, timeouts } = executors.created[0];
    const stepTimeouts = scripts
      .map((s, i) => (stepFilenameOf(s) ? timeouts[i] : undefined))
      .filter((t) => t !== undefined);
    expect(stepTimeouts).toEqual([1_800_000, 1_800_000, 1_800_000]);
  });

  it('closes the selected-share connection after the phase and keeps the credential', async () => {
    const { events, outcome } = await run();
    const closeAt = events.lastIndexOf('guest:close');
    const lastStepAt = events.reduce(
      (acc, e, i) => (e.includes('running step pre-scripts/') ? i : acc),
      -1,
    );
    expect(closeAt).toBeGreaterThan(lastStepAt);
    expect(events).not.toContain('guest:cleanup');
    const failure = expectFailure(outcome);
    expect(failure.credentials).toEqual([
      { role: 'default', hostIp: HOST_CONTEXT.defaultSwitchHostIp, status: 'verified' },
    ]);
  });

  describe('a failed step', () => {
    it('fails at G6 naming the step, stops the sequence, and leaves the residual state of the G6 row', async () => {
      const share = shareGuest();
      const { outcome, executors, out } = await run({
        share,
        guest: failingStep(
          '02-install-pnpm.ps1',
          { exitCode: 5, stdout: 'partial', stderr: 'pnpm exploded', timedOut: false },
          structuralChecksBehavior({}, share),
        ),
      });
      const failure = expectFailure(outcome);
      expect(failure.phase).toBe('G6');
      expect(failure.stepFilename).toBe('02-install-pnpm.ps1');
      expect(failure.error.kind).toBe('step-exit');
      expect(failure.error.message).toContain('code 5');
      expect(failure.error.message).toContain('pnpm exploded');
      // Fail-fast: the third step never started, and nothing was retried.
      expect(stepsRun(executors)).toEqual(['01-install-packages.ps1', '02-install-pnpm.ps1']);
      // The failed step's captured output was emitted.
      expect(out).toContain('  pnpm exploded');
      // Row G6: partial provisioning, the verified credential kept, no rollback, executor disposed.
      expect(failure.credentials).toEqual([
        { role: 'default', hostIp: HOST_CONTEXT.defaultSwitchHostIp, status: 'verified' },
      ]);
      expect(share.stored.has(HOST_CONTEXT.defaultSwitchHostIp)).toBe(true);
      expect(executors.created[0].disposed).toBe(true);
    });

    it('closes the open selected-share connection on the way out', async () => {
      const { events } = await run({
        guest: failingStep('01-install-packages.ps1', {
          exitCode: 1,
          stdout: '',
          stderr: '',
          timedOut: false,
        }),
      });
      expect(events).toContain('guest:cleanup');
    });

    it('classifies a timeout separately', async () => {
      const { outcome } = await run({
        guest: failingStep('01-install-packages.ps1', {
          exitCode: 124,
          stdout: '',
          stderr: '',
          timedOut: true,
        }),
      });
      const failure = expectFailure(outcome);
      expect(failure.phase).toBe('G6');
      expect(failure.stepFilename).toBe('01-install-packages.ps1');
      expect(failure.error.kind).toBe('step-timeout');
      expect(failure.error.message).toContain('30 minutes');
    });

    it('classifies a transport failure separately, naming the step', async () => {
      const { outcome } = await run({
        guest: failingStep(
          '02-install-pnpm.ps1',
          new WindowsGuestError('transport', 'the VM went away'),
        ),
      });
      const failure = expectFailure(outcome);
      expect(failure.error.kind).toBe('step-transport');
      expect(failure.stepFilename).toBe('02-install-pnpm.ps1');
      expect(failure.error.message).toContain('the VM went away');
    });

    it('reports a cancellation during a step as cancelled, naming the step', async () => {
      const controller = new AbortController();
      const inner = structuralChecksBehavior();
      const { outcome, executors } = await run({
        signal: controller.signal,
        guest: (script, credential) => {
          if (stepFilenameOf(script) === '02-install-pnpm.ps1') {
            controller.abort();
            return new WindowsGuestError('cancelled', 'cancelled');
          }
          return inner(script, credential);
        },
      });
      expect(outcome).toMatchObject({
        kind: 'cancelled',
        phase: 'G6',
        reason: 'interrupt',
        stepFilename: '02-install-pnpm.ps1',
      });
      expect(stepsRun(executors)).toEqual(['01-install-packages.ps1', '02-install-pnpm.ps1']);
      expect(executors.created[0].disposed).toBe(true);
    });
  });
});
