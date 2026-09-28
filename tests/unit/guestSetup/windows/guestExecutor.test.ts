import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWindowsGuestExecutor,
  waitForPowerShellDirect,
  WindowsGuestError,
  type WindowsGuestResult,
} from '../../../../src/guestSetup/windows/guestExecutor';
import { createFakeBridgeFactory, errorEnvelope, resultEnvelope } from './fakeBridge';

const credential = { username: 'Guest-Admin', password: "s3cret-'-$-☃" };

describe('createWindowsGuestExecutor', () => {
  it('exposes the VM name it is scoped to', () => {
    const { spawn } = createFakeBridgeFactory(() => {});
    const executor = createWindowsGuestExecutor({ vmName: 'vm-1', credential, spawnBridge: spawn });
    expect(executor.vmName).toBe('vm-1');
  });

  it('starts the bridge with only its path and the VM name in argv', async () => {
    const { spawn, calls } = createFakeBridgeFactory((_request, bridge) =>
      bridge.finish(resultEnvelope()),
    );
    const executor = createWindowsGuestExecutor({
      vmName: 'vm-1',
      credential,
      bridgePath: 'C:\\pkg\\templates\\powershell\\windowsGuestBridge.ps1',
      spawnBridge: spawn,
    });

    await executor.invoke('Write-Output "top-secret-script"', { timeoutMs: 5000 });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('powershell.exe');
    expect(calls[0].args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-File',
      'C:\\pkg\\templates\\powershell\\windowsGuestBridge.ps1',
      '-VMName',
      'vm-1',
    ]);
    const argv = calls[0].args.join(' ');
    expect(argv).not.toContain(credential.password);
    expect(argv).not.toContain(credential.username);
    expect(argv).not.toContain('top-secret-script');
  });

  it('sends the credential and the base64 script over stdin as one JSON request', async () => {
    const { spawn, calls } = createFakeBridgeFactory((_request, bridge) =>
      bridge.finish(resultEnvelope()),
    );
    const executor = createWindowsGuestExecutor({ vmName: 'vm-1', credential, spawnBridge: spawn });
    const script = 'Write-Output \'a "b" `c` $d\'\nsnowman ☃ 𠜎';

    await executor.invoke(script, { timeoutMs: 4321 });

    expect(JSON.parse(calls[0].stdin)).toEqual({
      username: credential.username,
      password: credential.password,
      scriptBase64: Buffer.from(script, 'utf8').toString('base64'),
      timeoutMs: 4321,
    });
    // Escaped so the bridge's console input encoding can never mangle them.
    expect(calls[0].stdin).toMatch(/^[\x20-\x7e]*$/);
  });

  it('returns the completed exit code, stdout and stderr, including a nonzero exit', async () => {
    const { spawn } = createFakeBridgeFactory((_request, bridge) =>
      bridge.finish(resultEnvelope({ exitCode: 23, stdout: 'out ☃', stderr: 'err' })),
    );
    const executor = createWindowsGuestExecutor({ vmName: 'vm-1', credential, spawnBridge: spawn });

    await expect(executor.invoke('exit 23', { timeoutMs: 5000 })).resolves.toEqual({
      exitCode: 23,
      stdout: 'out ☃',
      stderr: 'err',
      timedOut: false,
    });
  });
});

describe('failure classification', () => {
  const script = 'Write-Output "distinctive-script-body"';

  async function failureOf(
    respond: (bridge: Parameters<Parameters<typeof createFakeBridgeFactory>[0]>[1]) => void,
    overrides: { spawnError?: Error } = {},
  ): Promise<WindowsGuestError> {
    const { spawn } = createFakeBridgeFactory((_request, bridge) => respond(bridge));
    const executor = createWindowsGuestExecutor({
      vmName: 'vm-1',
      credential,
      spawnBridge: overrides.spawnError
        ? () => {
            throw overrides.spawnError;
          }
        : spawn,
    });
    const error = await executor.invoke(script, { timeoutMs: 5000 }).then(
      () => {
        throw new Error('expected the invocation to fail');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WindowsGuestError);
    return error as WindowsGuestError;
  }

  function expectRedacted(error: WindowsGuestError): void {
    const everything = JSON.stringify({ message: error.message, stack: error.stack, error });
    expect(everything).not.toContain(credential.password);
    expect(everything).not.toContain(credential.username);
    expect(everything).not.toContain('distinctive-script-body');
    expect(everything).not.toContain(Buffer.from(script, 'utf8').toString('base64'));
  }

  it('classifies a bridge-reported authentication failure', async () => {
    const error = await failureOf((bridge) =>
      bridge.finish(errorEnvelope('authentication', 'The credential is invalid.'), 1),
    );
    expect(error.kind).toBe('authentication');
    expect(error.message).toContain('The credential is invalid.');
  });

  it('classifies a bridge-reported transport failure as retryable transport', async () => {
    const error = await failureOf((bridge) =>
      bridge.finish(errorEnvelope('transport', 'The virtual machine is not running.'), 1),
    );
    expect(error.kind).toBe('transport');
  });

  it('classifies a bridge-reported protocol failure', async () => {
    const error = await failureOf((bridge) =>
      bridge.finish(errorEnvelope('protocol', 'The request was not valid JSON.'), 1),
    );
    expect(error.kind).toBe('protocol');
  });

  it('redacts the credential and script when the bridge echoes them in a message', async () => {
    const error = await failureOf((bridge) =>
      bridge.finish(
        errorEnvelope(
          'authentication',
          `Logon failed for ${credential.username} with ${credential.password} running ` +
            `${script} (${Buffer.from(script, 'utf8').toString('base64')})`,
        ),
        1,
      ),
    );
    expect(error.kind).toBe('authentication');
    expectRedacted(error);
  });

  it('treats output that is not a bridge envelope as a redacted protocol failure', async () => {
    const error = await failureOf((bridge) =>
      bridge.finish(
        `garbage with ${credential.password}`,
        0,
        `stderr mentions ${credential.username}`,
      ),
    );
    expect(error.kind).toBe('protocol');
    expectRedacted(error);
  });

  it('treats an envelope with the wrong shape as a protocol failure', async () => {
    const error = await failureOf((bridge) =>
      bridge.finish(`${JSON.stringify({ kind: 'result', exitCode: 'zero' })}\n`),
    );
    expect(error.kind).toBe('protocol');
  });

  it('treats a bridge that exits nonzero without an envelope as a protocol failure', async () => {
    const error = await failureOf((bridge) => bridge.finish('', 1, `boom ${credential.password}`));
    expect(error.kind).toBe('protocol');
    expect(error.message).toContain('exited with code 1');
    expectRedacted(error);
  });

  it('treats a bridge that cannot be started as a protocol failure', async () => {
    const error = await failureOf(() => {}, {
      spawnError: new Error(`spawn failed for ${credential.password}`),
    });
    expect(error.kind).toBe('protocol');
    expectRedacted(error);
  });
});

describe('deadlines, cancellation and disposal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function silentBridge() {
    const factory = createFakeBridgeFactory(() => {});
    const executor = createWindowsGuestExecutor({
      vmName: 'vm-1',
      credential,
      spawnBridge: factory.spawn,
      bridgeMarginMs: 1000,
      disposeTimeoutMs: 500,
    });
    return { ...factory, executor };
  }

  it('returns the guest-side timeout as a result, not a failure', async () => {
    const { spawn } = createFakeBridgeFactory((_request, bridge) =>
      bridge.finish(resultEnvelope({ exitCode: 124, timedOut: true, stdout: 'partial' })),
    );
    const executor = createWindowsGuestExecutor({ vmName: 'vm-1', credential, spawnBridge: spawn });
    await expect(executor.invoke('sleep', { timeoutMs: 100 })).resolves.toEqual({
      exitCode: 124,
      stdout: 'partial',
      stderr: '',
      timedOut: true,
    });
  });

  it('force-kills a wedged bridge only after the deadline plus the margin', async () => {
    const { executor, calls } = silentBridge();
    const outcome = executor.invoke('sleep', { timeoutMs: 5000 }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5999);
    expect(calls[0].process.killed).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(calls[0].process.killed).toBe(true);
    const error = (await outcome) as WindowsGuestError;
    expect(error).toBeInstanceOf(WindowsGuestError);
    expect(error.kind).toBe('deadline');
    expect(error.message).not.toContain(credential.password);
  });

  it('does not start the bridge when the signal is already aborted', async () => {
    const { executor, calls } = silentBridge();
    const controller = new AbortController();
    controller.abort();
    await expect(
      executor.invoke('x', { timeoutMs: 5000, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(calls).toHaveLength(0);
  });

  it('returns a cancelled outcome promptly and leaves the bridge to reap the guest child', async () => {
    const { executor, calls } = silentBridge();
    const controller = new AbortController();
    const outcome = executor
      .invoke('sleep', { timeoutMs: 5000, signal: controller.signal })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const error = (await outcome) as WindowsGuestError;
    expect(error.kind).toBe('cancelled');
    expect(calls[0].process.killed).toBe(false);

    // The bridge later finishes on its own and disposal observes that.
    const disposed = executor.dispose();
    calls[0].process.finish(resultEnvelope({ exitCode: 124, timedOut: true }));
    await vi.advanceTimersByTimeAsync(10);
    await disposed;
    expect(calls[0].process.killed).toBe(false);
  });

  it('bounds disposal by force-killing a bridge that never finishes', async () => {
    const { executor, calls } = silentBridge();
    const controller = new AbortController();
    const outcome = executor
      .invoke('sleep', { timeoutMs: 600_000, signal: controller.signal })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await outcome;

    const disposed = executor.dispose();
    await vi.advanceTimersByTimeAsync(499);
    expect(calls[0].process.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await disposed;
    expect(calls[0].process.killed).toBe(true);
  });

  it('refuses invocations after disposal', async () => {
    const { executor, calls } = silentBridge();
    await executor.dispose();
    await expect(executor.invoke('x', { timeoutMs: 1000 })).rejects.toThrow(/disposed/);
    expect(calls).toHaveLength(0);
  });
});

describe('waitForPowerShellDirect', () => {
  type Outcome = WindowsGuestResult | WindowsGuestError;

  function scriptedExecutor(outcomes: Outcome[]) {
    const invocations: { script: string; timeoutMs: number }[] = [];
    const executor = {
      vmName: 'vm-1',
      async invoke(script: string, options: { timeoutMs: number }) {
        invocations.push({ script, timeoutMs: options.timeoutMs });
        const outcome = outcomes[Math.min(invocations.length - 1, outcomes.length - 1)];
        if (outcome instanceof WindowsGuestError) throw outcome;
        return outcome;
      },
      async dispose() {},
    };
    return { executor, invocations };
  }

  function fakeClock() {
    let now = 0;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
  }

  const ready: WindowsGuestResult = {
    exitCode: 0,
    stdout: 'ready\r\n',
    stderr: '',
    timedOut: false,
  };
  const notReady = new WindowsGuestError('transport', 'The virtual machine is not running.');

  it('returns ready as soon as the probe answers', async () => {
    const { executor, invocations } = scriptedExecutor([ready]);
    await expect(
      waitForPowerShellDirect(executor, { deadlineMs: 60_000, ...fakeClock() }),
    ).resolves.toBe('ready');
    expect(invocations).toHaveLength(1);
  });

  it('retries a not-ready transport on the probe interval and reports heartbeats', async () => {
    const { executor, invocations } = scriptedExecutor([
      notReady,
      notReady,
      notReady,
      notReady,
      notReady,
      notReady,
      ready,
    ]);
    const heartbeats: number[] = [];
    await expect(
      waitForPowerShellDirect(executor, {
        deadlineMs: 120_000,
        probeIntervalMs: 5000,
        heartbeatIntervalMs: 10_000,
        onHeartbeat: (elapsedMs) => heartbeats.push(elapsedMs),
        ...fakeClock(),
      }),
    ).resolves.toBe('ready');
    expect(invocations).toHaveLength(7);
    expect(heartbeats).toEqual([10_000, 20_000]);
  });

  it('treats a probe that ran but did not answer as not ready yet', async () => {
    const wrong: WindowsGuestResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'starting',
      timedOut: false,
    };
    const { executor, invocations } = scriptedExecutor([wrong, ready]);
    await expect(
      waitForPowerShellDirect(executor, { deadlineMs: 60_000, ...fakeClock() }),
    ).resolves.toBe('ready');
    expect(invocations).toHaveLength(2);
  });

  it('returns auth-rejected at once instead of retrying bad credentials into a timeout', async () => {
    const rejected = new WindowsGuestError('authentication', 'The credential is invalid.');
    const { executor, invocations } = scriptedExecutor([notReady, rejected]);
    await expect(
      waitForPowerShellDirect(executor, { deadlineMs: 60_000, ...fakeClock() }),
    ).resolves.toBe('auth-rejected');
    expect(invocations).toHaveLength(2);
  });

  it('throws a protocol failure immediately', async () => {
    const broken = new WindowsGuestError('protocol', 'bridge exploded');
    const { executor, invocations } = scriptedExecutor([broken]);
    await expect(
      waitForPowerShellDirect(executor, { deadlineMs: 60_000, ...fakeClock() }),
    ).rejects.toMatchObject({ kind: 'protocol' });
    expect(invocations).toHaveLength(1);
  });

  it('throws a timeout naming the last transport failure once the deadline passes', async () => {
    const { executor } = scriptedExecutor([notReady]);
    const error = await waitForPowerShellDirect(executor, {
      deadlineMs: 20_000,
      probeIntervalMs: 5000,
      ...fakeClock(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WindowsGuestError);
    expect((error as WindowsGuestError).kind).toBe('timeout');
    expect((error as WindowsGuestError).message).toContain('vm-1');
    expect((error as WindowsGuestError).message).toContain('The virtual machine is not running.');
  });

  it('retries a wedged bridge like any other transport problem', async () => {
    const wedged = new WindowsGuestError('deadline', 'the bridge did not finish');
    const { executor } = scriptedExecutor([wedged, ready]);
    await expect(
      waitForPowerShellDirect(executor, { deadlineMs: 60_000, ...fakeClock() }),
    ).resolves.toBe('ready');
  });

  it('stops with a cancelled failure when the signal aborts', async () => {
    const { executor, invocations } = scriptedExecutor([notReady]);
    const controller = new AbortController();
    const clock = fakeClock();
    const error = await waitForPowerShellDirect(executor, {
      deadlineMs: 600_000,
      signal: controller.signal,
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        controller.abort();
      },
    }).catch((caught: unknown) => caught);
    expect((error as WindowsGuestError).kind).toBe('cancelled');
    expect(invocations).toHaveLength(1);
  });
});
