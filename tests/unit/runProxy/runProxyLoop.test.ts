import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runProxyLoop,
  type RunProxyConfig,
  type RunProxyDeps,
} from '../../../src/runProxy/runProxyLoop';
import type { Credentials } from '../../../src/runProxy/types';

const MIN = 60_000;

function baseConfig(overrides: Partial<RunProxyConfig> = {}): RunProxyConfig {
  return {
    credentialsPath: '/fake/.credentials.json',
    secretPath: '/fake/sds-secret.yaml',
    serviceName: 'envoy',
    refreshWindowMs: 3 * MIN,
    retryIntervalMs: 2 * MIN,
    maxAttempts: 3,
    refreshEnabled: true,
    ...overrides,
  };
}

interface Harness {
  deps: RunProxyDeps;
  creds: { value: Credentials };
  fireWatcher: () => void;
  fireSigint: () => void;
  mocks: {
    writeSecret: ReturnType<typeof vi.fn>;
    recreateContainer: ReturnType<typeof vi.fn>;
    nudgeRefresh: ReturnType<typeof vi.fn>;
    watchClose: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(initial: Credentials): Harness {
  const creds = { value: initial };
  let watcherCb: (() => void) | null = null;
  let sigintCb: (() => void) | null = null;
  const watchClose = vi.fn();
  const mocks = {
    writeSecret: vi.fn(),
    recreateContainer: vi.fn().mockResolvedValue(undefined),
    nudgeRefresh: vi.fn().mockResolvedValue({ ok: true, stderr: '' }),
    watchClose,
    error: vi.fn(),
  };
  const deps: RunProxyDeps = {
    readCredentials: () => creds.value,
    writeSecret: mocks.writeSecret,
    recreateContainer: mocks.recreateContainer,
    nudgeRefresh: mocks.nudgeRefresh,
    watch: (_path, onEvent) => {
      watcherCb = onEvent;
      return { close: watchClose };
    },
    onSigint: (handler) => {
      sigintCb = handler;
    },
    log: vi.fn(),
    error: mocks.error,
    now: () => Date.now(),
  };
  return {
    deps,
    creds,
    fireWatcher: () => watcherCb?.(),
    fireSigint: () => sigintCb?.(),
    mocks,
  };
}

/** Flush pending microtasks + zero-delay timers so async startup/handlers settle. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runProxyLoop', () => {
  it('writes the secret and recreates the container on startup', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();

    expect(h.mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/sds-secret.yaml');
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1);
  });

  it('propagates a changed token on a watcher event: writeSecret + recreate once', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.writeSecret.mockClear();
    h.mocks.recreateContainer.mockClear();

    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireWatcher();
    await flush();

    expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1);
  });

  it('does not propagate when the token is unchanged', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.recreateContainer.mockClear();

    h.creds.value = { accessToken: 'A', expiresAt: 61 * MIN }; // only expiry moved
    h.fireWatcher();
    await flush();

    expect(h.mocks.recreateContainer).not.toHaveBeenCalled();
  });

  it('exits non-zero after maxAttempts consecutive no-advance nudges', async () => {
    // expiresAt within the refresh window so the nudge fires immediately at startup.
    const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
    const exit = runProxyLoop(baseConfig({ maxAttempts: 3 }), h.deps);
    await flush(); // startup arms nudge at now -> fires -> doNudge #1

    // Each retryInterval with no expiresAt advance is one failed attempt.
    await vi.advanceTimersByTimeAsync(2 * MIN); // deadline -> fail #1 -> doNudge #2
    await vi.advanceTimersByTimeAsync(2 * MIN); // deadline -> fail #2 -> doNudge #3
    await vi.advanceTimersByTimeAsync(2 * MIN); // deadline -> fail #3 -> exit

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.nudgeRefresh).toHaveBeenCalledTimes(3);
    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('token did not refresh after 3 attempts'),
    );
  });

  it('resets the failure counter when a refresh succeeds mid-sequence', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
    const exit = runProxyLoop(baseConfig({ maxAttempts: 3 }), h.deps);
    await flush(); // doNudge #1
    await vi.advanceTimersByTimeAsync(2 * MIN); // fail #1 -> doNudge #2

    // Simulate the refresh landing: expiresAt advances far out.
    h.creds.value = { accessToken: 'A', expiresAt: 60 * MIN };
    h.fireWatcher();
    await flush();

    // Two more no-advance intervals would have exited if the counter had not reset.
    await vi.advanceTimersByTimeAsync(60 * MIN);
    await Promise.resolve();

    let settled = false;
    void exit.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('retries a propagate docker failure once, then exits non-zero', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    h.mocks.recreateContainer.mockRejectedValue(new Error('docker boom'));
    h.mocks.recreateContainer.mockClear();
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireWatcher();
    await flush();

    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(2); // initial + one retry
    await expect(exit).resolves.toBe(1);
  });

  it('on SIGINT tears down and exits 0 without touching the container', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.recreateContainer.mockClear();

    h.fireSigint();

    await expect(exit).resolves.toBe(0);
    expect(h.mocks.watchClose).toHaveBeenCalledTimes(1);
    expect(h.mocks.recreateContainer).not.toHaveBeenCalled();
  });
});
