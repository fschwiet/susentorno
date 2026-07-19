import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runProxyLoop,
  type RunProxyConfig,
  type RunProxyDeps,
} from '../../../src/runProxy/runProxyLoop';
import type { Credentials, ColorPorts, Color } from '../../../src/runProxy/types';

const MIN = 60_000;

const VALID_ALLOWLIST = [
  '#pragma passthrough',
  'pypi.org:443',
  '',
  '#pragma claude authenticated',
  'api.anthropic.com:443',
  '',
].join('\n');

const INVALID_ALLOWLIST = ['#pragma claude authenticated', '*.bad.example.com:443', ''].join('\n');

const PASS_LINE = 'envoy-1  | CFGM|pass|2026-07-10T12:00:00|pypi.org|-|-';
const CRED_LINE =
  'envoy-1  | CFGM|term|2026-07-10T12:00:01|api.anthropic.com|api.anthropic.com|via_upstream';

function baseConfig(overrides: Partial<RunProxyConfig> = {}): RunProxyConfig {
  return {
    credentialsPath: '/fake/.credentials.json',
    allowlistPath: '/fake/allowlist.txt',
    secretPath: '/fake/sds-secret.yaml',
    readyTimeoutMs: 30_000,
    drainTimeoutMs: 30_000,
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
  allowlist: { value: string | null };
  fireCredentials: () => void;
  fireAllowlist: () => void;
  fireSigint: () => void;
  feedLogLine: (raw: string) => void;
  mocks: {
    writeSecret: ReturnType<typeof vi.fn>;
    allocatePorts: ReturnType<typeof vi.fn>;
    bringUpColor: ReturnType<typeof vi.fn>;
    waitColorReady: ReturnType<typeof vi.fn>;
    setActiveBackend: ReturnType<typeof vi.fn>;
    drainBackend: ReturnType<typeof vi.fn>;
    stopColor: ReturnType<typeof vi.fn>;
    nudgeRefresh: ReturnType<typeof vi.fn>;
    buildConfig: ReturnType<typeof vi.fn>;
    ensureLeaf: ReturnType<typeof vi.fn>;
    startLogStream: ReturnType<typeof vi.fn>;
    stopLogStream: ReturnType<typeof vi.fn>;
    watchClose: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(
  initial: Credentials,
  initialAllowlist: string | null = VALID_ALLOWLIST,
): Harness {
  const creds = { value: initial };
  const allowlist = { value: initialAllowlist };
  let credentialsCb: (() => void) | null = null;
  let allowlistCb: (() => void) | null = null;
  let sigintCb: (() => void) | null = null;
  let onLine: ((raw: string) => void) | null = null;
  const watchClose = vi.fn();

  let portSeq = 0;
  const nextPorts = (): ColorPorts => {
    portSeq += 1;
    return { httpsPort: 20000 + portSeq, httpPort: 21000 + portSeq, adminPort: 22000 + portSeq };
  };

  const mocks = {
    writeSecret: vi.fn(),
    allocatePorts: vi.fn(async () => nextPorts()),
    bringUpColor: vi.fn().mockResolvedValue(undefined),
    waitColorReady: vi.fn().mockResolvedValue({ ready: true }),
    setActiveBackend: vi.fn(),
    drainBackend: vi.fn().mockResolvedValue(undefined),
    stopColor: vi.fn().mockResolvedValue(undefined),
    nudgeRefresh: vi.fn().mockResolvedValue({ ok: true, stderr: '' }),
    buildConfig: vi.fn(),
    ensureLeaf: vi.fn().mockReturnValue('reused leaf for 1 host(s)'),
    startLogStream: vi.fn((_color: string, cb: (raw: string) => void) => {
      onLine = cb;
    }),
    stopLogStream: vi.fn().mockResolvedValue(undefined),
    watchClose,
    log: vi.fn(),
    error: vi.fn(),
  };
  const deps: RunProxyDeps = {
    readCredentials: () => creds.value,
    readAllowlist: () => allowlist.value,
    writeSecret: mocks.writeSecret,
    buildConfig: mocks.buildConfig,
    ensureLeaf: mocks.ensureLeaf,
    allocatePorts: mocks.allocatePorts,
    bringUpColor: mocks.bringUpColor,
    waitColorReady: mocks.waitColorReady,
    setActiveBackend: mocks.setActiveBackend,
    drainBackend: mocks.drainBackend,
    stopColor: mocks.stopColor,
    nudgeRefresh: mocks.nudgeRefresh,
    watch: (path, onEvent) => {
      if (path.endsWith('.credentials.json')) credentialsCb = onEvent;
      else allowlistCb = onEvent;
      return { close: watchClose };
    },
    startLogStream: mocks.startLogStream,
    stopLogStream: mocks.stopLogStream,
    onSigint: (handler) => {
      sigintCb = handler;
    },
    log: mocks.log,
    error: mocks.error,
    now: () => Date.now(),
  };
  return {
    deps,
    creds,
    allowlist,
    fireCredentials: () => credentialsCb?.(),
    fireAllowlist: () => allowlistCb?.(),
    fireSigint: () => sigintCb?.(),
    feedLogLine: (raw) => onLine?.(raw),
    mocks,
  };
}

/** Flush microtasks + zero-delay timers so the multi-await swap chain settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runProxyLoop startup', () => {
  it('builds config, ensures leaf, writes secret, brings up blue, sets backend, logs', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();

    expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(['api.anthropic.com']);
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.buildConfig.mock.calls[0][0].terminate).toEqual(['api.anthropic.com:443']);
    expect(h.mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/sds-secret.yaml');
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
    expect(h.mocks.bringUpColor.mock.calls[0][0]).toBe('blue');
    expect(h.mocks.waitColorReady).toHaveBeenCalledTimes(1);
    expect(h.mocks.setActiveBackend).toHaveBeenCalledTimes(1);
    expect(h.mocks.startLogStream).toHaveBeenCalledTimes(1);
    expect(h.mocks.startLogStream.mock.calls[0][0]).toBe('blue');
  });

  it('exits 1 on an invalid allowlist without touching docker', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, INVALID_ALLOWLIST);
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('unsupported wildcard syntax'),
    );
    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('*.bad.example.com:443'));
    expect(h.mocks.buildConfig).not.toHaveBeenCalled();
    expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
  });

  it('exits 1 when the allowlist is unreadable', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, null);
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('could not read allowlist'));
  });

  it('exits 1 when blue never becomes ready on startup', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    h.mocks.waitColorReady.mockResolvedValue({ ready: false, reason: 'timeout' });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('did not become ready on startup'),
    );
    expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
  });

  it('exits 1 with the exit hint when blue exits during startup', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    h.mocks.waitColorReady.mockResolvedValue({ ready: false, reason: 'exited' });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('exited during startup'));
    expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
  });

  it('applies an allowlist change that lands during the startup bring-up', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    let release!: () => void;
    h.mocks.bringUpColor.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    void runProxyLoop(baseConfig(), h.deps);
    await flush(); // startup bring-up in flight; both watchers already armed

    h.allowlist.value = VALID_ALLOWLIST.replace(
      'pypi.org:443',
      'pypi.org:443\nlate.example.com:443',
    );
    h.fireAllowlist();
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1); // still just the startup one

    release();
    await flush();

    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // startup + coalesced swap
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(2);
    expect(h.mocks.buildConfig.mock.calls[1][0].passthrough).toContain('late.example.com:443');
  });
});

describe('runProxyLoop inline logging', () => {
  it('prints each parsed host+handling once and ignores non-CFGM lines', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.log.mockClear();

    h.feedLogLine('[2026-07-10 12:00:00.000][1][info][main] envoy operational line');
    h.feedLogLine(PASS_LINE);
    h.feedLogLine(PASS_LINE);
    h.feedLogLine(CRED_LINE);

    expect(h.mocks.log.mock.calls.map((c) => c[0])).toEqual([
      '12:00:00  ALLOW PASS  pypi.org',
      '12:00:01  ALLOW CRED  api.anthropic.com',
    ]);
  });
});

describe('runProxyLoop allowlist changes', () => {
  it('rebuilds config, reissues leaf, swaps to green, and clears unique tracking', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.feedLogLine(PASS_LINE); // pypi.org now tracked as seen
    h.mocks.buildConfig.mockClear();
    h.mocks.ensureLeaf.mockClear();
    h.mocks.bringUpColor.mockClear();
    h.mocks.log.mockClear();

    h.allowlist.value = VALID_ALLOWLIST.replace('pypi.org:443', 'pypi.org:443\nexample.org:443');
    h.fireAllowlist();
    await flush();

    expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(['api.anthropic.com']);
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.buildConfig.mock.calls[0][0].passthrough).toContain('example.org:443');
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: restarting proxy — allowlist changed');
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
    expect(h.mocks.bringUpColor.mock.calls[0][0]).toBe('green');
    expect(h.mocks.stopLogStream).toHaveBeenCalledTimes(1);
    expect(h.mocks.drainBackend).toHaveBeenCalledTimes(1);
    expect(h.mocks.stopColor).toHaveBeenCalledWith('blue');
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: swap complete — now serving green');
    expect(h.mocks.startLogStream).toHaveBeenCalledTimes(2); // startup(blue) + swap(green)
    expect(h.mocks.startLogStream.mock.calls[1][0]).toBe('green');

    // Unique tracking was cleared: the same host+handling prints again.
    h.mocks.log.mockClear();
    h.feedLogLine(PASS_LINE);
    expect(h.mocks.log).toHaveBeenCalledWith('12:00:00  ALLOW PASS  pypi.org');
  });

  it('keeps the previous config on an invalid edit and stays live for the fix', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.buildConfig.mockClear();
    h.mocks.bringUpColor.mockClear();

    h.allowlist.value = INVALID_ALLOWLIST;
    h.fireAllowlist();
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('allowlist has unsupported wildcard syntax, keeping previous config'),
    );
    expect(h.mocks.buildConfig).not.toHaveBeenCalled();
    expect(h.mocks.bringUpColor).not.toHaveBeenCalled();

    // The watcher stayed live: fixing the file triggers a fresh swap.
    h.allowlist.value = VALID_ALLOWLIST;
    h.fireAllowlist();
    await flush();
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
  });
});

describe('runProxyLoop credential changes', () => {
  it('propagates a changed token via a swap, preserving unique tracking', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.feedLogLine(PASS_LINE); // pypi.org tracked as seen
    h.mocks.writeSecret.mockClear();
    h.mocks.bringUpColor.mockClear();
    h.mocks.log.mockClear();

    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
    expect(h.mocks.bringUpColor).toHaveBeenCalledWith('green', expect.anything());
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: restarting proxy — credentials changed');
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: swap complete — now serving green');

    // Unique tracking survived the credential swap.
    h.mocks.log.mockClear();
    h.feedLogLine(PASS_LINE);
    expect(h.mocks.log).not.toHaveBeenCalled();
    h.feedLogLine(CRED_LINE); // a new key still prints (stream is live)
    expect(h.mocks.log).toHaveBeenCalledWith('12:00:01  ALLOW CRED  api.anthropic.com');
  });

  it('alternates the active color across successive swaps', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();

    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: swap complete — now serving green');

    h.creds.value = { accessToken: 'C', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: swap complete — now serving blue');
    expect(h.mocks.stopColor.mock.calls.map((c) => c[0])).toEqual(['blue', 'green']);
  });

  it('does not swap when the token is unchanged', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.bringUpColor.mockClear();

    h.creds.value = { accessToken: 'A', expiresAt: 61 * MIN }; // only expiry moved
    h.fireCredentials();
    await flush();

    expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
  });

  it('keeps the old color serving (non-fatal) when the new color never becomes ready', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.setActiveBackend.mockClear();

    h.mocks.waitColorReady.mockResolvedValueOnce({ ready: false, reason: 'timeout' }); // the swap's green fails to serve
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('did not become ready — keeping the current proxy'),
    );
    expect(h.mocks.stopColor).toHaveBeenCalledWith('green'); // failed green torn down
    expect(h.mocks.setActiveBackend).not.toHaveBeenCalled(); // no flip
    // The loop is still running (not settled): a later SIGINT would resolve it.
    let settled = false;
    void exit.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
  });

  it('keeps the previous proxy and logs the exit hint when a swap color exits during startup', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    h.mocks.waitColorReady.mockResolvedValueOnce({ ready: false, reason: 'exited' });
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('exited during startup'));
    expect(h.mocks.stopColor).toHaveBeenCalledWith('green');
    let settled = false;
    void exit.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false); // non-fatal on a restart
  });

  it('keeps the old color serving when docker fails to bring up the new color', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.setActiveBackend.mockClear();

    h.mocks.bringUpColor.mockRejectedValueOnce(new Error('docker boom'));
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('could not start the new proxy'),
    );
    expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
    let settled = false;
    void exit.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
  });
});

describe('runProxyLoop coalescing', () => {
  it('collapses events during an in-flight swap into exactly one follow-up swap', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.bringUpColor.mockClear();

    let release!: () => void;
    h.mocks.bringUpColor.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    h.fireAllowlist(); // swap 1 begins; its bring-up is blocked
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

    h.fireAllowlist(); // two more edits land mid-swap
    h.fireAllowlist();
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1); // nothing new while in flight

    release();
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // exactly one follow-up
  });

  it('clears unique tracking when both sources changed during an in-flight swap', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.feedLogLine(PASS_LINE); // tracked
    h.mocks.bringUpColor.mockClear();

    let release!: () => void;
    h.mocks.bringUpColor.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

    // BOTH change while the first swap is in flight.
    h.creds.value = { accessToken: 'C', expiresAt: 60 * MIN };
    h.fireCredentials();
    h.allowlist.value = VALID_ALLOWLIST.replace(
      'pypi.org:443',
      'pypi.org:443\nboth.example.com:443',
    );
    h.fireAllowlist();
    await flush();

    release();
    await flush();
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // one follow-up for both

    // The follow-up included the allowlist change, so unique was cleared.
    h.mocks.log.mockClear();
    h.feedLogLine(PASS_LINE);
    expect(h.mocks.log).toHaveBeenCalledWith('12:00:00  ALLOW PASS  pypi.org');
  });
});

describe('runProxyLoop refresh nudging', () => {
  it('exits non-zero after maxAttempts consecutive no-advance nudges', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
    const exit = runProxyLoop(baseConfig({ maxAttempts: 3 }), h.deps);
    await flush();

    await vi.advanceTimersByTimeAsync(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.nudgeRefresh).toHaveBeenCalledTimes(3);
    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('token did not refresh after 3 attempts'),
    );
  });

  it('resets the failure counter when a refresh succeeds mid-sequence', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
    const exit = runProxyLoop(baseConfig({ maxAttempts: 3 }), h.deps);
    await flush();
    await vi.advanceTimersByTimeAsync(2 * MIN);

    h.creds.value = { accessToken: 'A', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    await vi.advanceTimersByTimeAsync(60 * MIN);
    await Promise.resolve();

    let settled = false;
    void exit.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});

describe('runProxyLoop shutdown', () => {
  it('SIGINT tears everything down once and exits 0; a second SIGINT is a no-op', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.log.mockClear();
    h.mocks.bringUpColor.mockClear();

    h.fireSigint();
    h.fireSigint();
    await flush();

    await expect(exit).resolves.toBe(0);
    const sigintLogs = h.mocks.log.mock.calls.filter((c) => String(c[0]).includes('SIGINT'));
    expect(sigintLogs).toHaveLength(1);
    expect(h.mocks.watchClose).toHaveBeenCalledTimes(2);
    expect(h.mocks.stopLogStream).toHaveBeenCalled();
    expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
  });

  it('SIGINT while waiting for a color to become ready aborts the wait and exits 0', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    h.mocks.waitColorReady.mockImplementationOnce(
      (_color: Color, _ports: ColorPorts, _timeoutMs: number, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ ready: false, reason: 'timeout' }), {
            once: true,
          });
        }),
    );
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush(); // parked in the startup waitColorReady

    h.fireSigint();
    await flush();

    await expect(exit).resolves.toBe(0);
    expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
  });
});
