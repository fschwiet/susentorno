import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runProxyLoop,
  type RunProxyConfig,
  type RunProxyDeps,
} from '../../src/runProxy/runProxyLoop';
import type { CredentialChannelConfig } from '../../src/runProxy/credentialChannel';
import type { Credentials, ColorPorts, Color } from '../../src/runProxy/types';

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

const COLLISION_ALLOWLIST = [
  '#pragma passthrough',
  'shared.example.com:443',
  '',
  '#pragma claude authenticated',
  'api.anthropic.com:443',
  'shared.example.com:443',
  '',
].join('\n');

const PASS_LINE = 'envoy-1  | CFGM|pass|2026-07-10T12:00:00|pypi.org|-|-|-|-|-|-';
const CRED_LINE =
  'envoy-1  | CFGM|term|2026-07-10T12:00:01|api.anthropic.com|api.anthropic.com|via_upstream|200|-|10|100';

function claudeChannelConfig(
  creds: { value: Credentials },
  mocks: {
    writeSecret: (token: string, path: string) => void;
    nudgeRefresh: () => Promise<{ ok: boolean; stderr: string }>;
  },
  overrides: Partial<CredentialChannelConfig> = {},
): CredentialChannelConfig {
  return {
    name: 'claude',
    credentialsPath: '/fake/.credentials.json',
    secretPath: '/fake/sds-secret.yaml',
    readCredentials: () => creds.value,
    writeSecret: mocks.writeSecret,
    nudgeRefresh: mocks.nudgeRefresh,
    refreshWindowMs: 3 * MIN,
    retryIntervalMs: 2 * MIN,
    maxAttempts: 3,
    refreshEnabled: true,
    ...overrides,
  };
}

function baseConfig(channels: CredentialChannelConfig[]): RunProxyConfig {
  return {
    channels,
    allowlistPath: '/fake/allowlist.txt',
    readyTimeoutMs: 30_000,
    drainTimeoutMs: 30_000,
  };
}

interface Harness {
  deps: RunProxyDeps;
  creds: { value: Credentials };
  allowlist: { value: string | null };
  channelConfig: CredentialChannelConfig;
  fireCredentials: (path?: string) => void;
  fireAllowlist: () => void;
  fireSigint: () => void;
  fireSigterm: () => void;
  feedLogLine: (raw: string) => void;
  mocks: {
    writeSecret: ReturnType<typeof vi.fn<(token: string, path: string) => void>>;
    allocatePorts: ReturnType<typeof vi.fn>;
    bringUpColor: ReturnType<typeof vi.fn>;
    waitColorReady: ReturnType<typeof vi.fn>;
    setActiveBackend: ReturnType<typeof vi.fn>;
    drainBackend: ReturnType<typeof vi.fn>;
    stopColor: ReturnType<typeof vi.fn>;
    nudgeRefresh: ReturnType<typeof vi.fn<() => Promise<{ ok: boolean; stderr: string }>>>;
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
  const credentialCbs = new Map<string, () => void>();
  let allowlistCb: (() => void) | null = null;
  let sigintCb: (() => void) | null = null;
  let sigtermCb: (() => void) | null = null;
  let onLine: ((raw: string) => void) | null = null;
  const watchClose = vi.fn();

  let portSeq = 0;
  const nextPorts = (): ColorPorts => {
    portSeq += 1;
    return { httpsPort: 20000 + portSeq, httpPort: 21000 + portSeq, adminPort: 22000 + portSeq };
  };

  const mocks = {
    writeSecret: vi.fn<(token: string, path: string) => void>(),
    allocatePorts: vi.fn(async () => nextPorts()),
    bringUpColor: vi.fn().mockResolvedValue(undefined),
    waitColorReady: vi.fn().mockResolvedValue({ ready: true }),
    setActiveBackend: vi.fn(),
    drainBackend: vi.fn().mockResolvedValue(undefined),
    stopColor: vi.fn().mockResolvedValue(undefined),
    nudgeRefresh: vi.fn(async () => ({ ok: true, stderr: '' })),
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
  const channelConfig = claudeChannelConfig(creds, mocks);
  const deps: RunProxyDeps = {
    readAllowlist: () => allowlist.value,
    buildConfig: mocks.buildConfig,
    ensureLeaf: mocks.ensureLeaf,
    allocatePorts: mocks.allocatePorts,
    bringUpColor: mocks.bringUpColor,
    waitColorReady: mocks.waitColorReady,
    setActiveBackend: mocks.setActiveBackend,
    drainBackend: mocks.drainBackend,
    stopColor: mocks.stopColor,
    watch: (path, onEvent) => {
      if (path.endsWith('allowlist.txt')) allowlistCb = onEvent;
      else credentialCbs.set(path, onEvent);
      return { close: watchClose };
    },
    startLogStream: mocks.startLogStream,
    stopLogStream: mocks.stopLogStream,
    onSigint: (handler) => {
      sigintCb = handler;
    },
    onSigterm: (handler) => {
      sigtermCb = handler;
    },
    log: mocks.log,
    error: mocks.error,
    now: () => Date.now(),
  };
  return {
    deps,
    creds,
    allowlist,
    channelConfig,
    fireCredentials: (path = '/fake/.credentials.json') => credentialCbs.get(path)?.(),
    fireAllowlist: () => allowlistCb?.(),
    fireSigint: () => sigintCb?.(),
    fireSigterm: () => sigtermCb?.(),
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

describe('proxy stack supervision', () => {
  describe('startup', () => {
    it('builds config, ensures leaf, writes secret, brings up blue, sets backend, logs', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(['api.anthropic.com']);
      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
      expect(h.mocks.buildConfig.mock.calls[0][0].claudeAuthenticated).toEqual([
        'api.anthropic.com:443',
      ]);
      expect(h.mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/sds-secret.yaml');
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
      expect(h.mocks.bringUpColor.mock.calls[0][0]).toBe('blue');
      expect(h.mocks.waitColorReady).toHaveBeenCalledTimes(1);
      expect(h.mocks.setActiveBackend).toHaveBeenCalledTimes(1);
      expect(h.mocks.startLogStream).toHaveBeenCalledTimes(1);
      expect(h.mocks.startLogStream.mock.calls[0][0]).toBe('blue');
    });

    it('warns but still brings up the proxy on an invalid-syntax allowlist', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, INVALID_ALLOWLIST);
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining('unsupported wildcard syntax'),
      );
      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

      // Still running (not settled): a later SIGINT would resolve it.
      let settled = false;
      void exit.then(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false);
    });

    it('warns and resolves a collision, then brings up the proxy from the resolved config', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, COLLISION_ALLOWLIST);
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated; using claudeAuthenticated",
        ),
      );
      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
      expect(h.mocks.buildConfig.mock.calls[0][0].claudeAuthenticated).toEqual([
        'api.anthropic.com:443',
        'shared.example.com:443',
      ]);
      expect(h.mocks.buildConfig.mock.calls[0][0].passthrough).toEqual([]);
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
    });

    it('exits 1 when the allowlist is unreadable', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, null);
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining('could not read allowlist'),
      );
    });

    it('exits 1 when blue never becomes ready on startup', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      h.mocks.waitColorReady.mockResolvedValue({ ready: false, reason: 'timeout' });
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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

  describe('inline access logging', () => {
    it('prints each parsed host+handling once and ignores non-CFGM lines', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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

  describe('allowlist changes', () => {
    it('rebuilds config, reissues leaf, swaps to green, and clears unique tracking', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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

    it('applies the resolved config on a flawed edit and warns instead of keeping previous', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.buildConfig.mockClear();
      h.mocks.bringUpColor.mockClear();

      h.allowlist.value = COLLISION_ALLOWLIST;
      h.fireAllowlist();
      await flush();

      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining("collision: 'shared.example.com:443'"),
      );
      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
      expect(h.mocks.buildConfig.mock.calls[0][0].claudeAuthenticated).toContain(
        'shared.example.com:443',
      );
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
    });
  });

  describe('credential changes', () => {
    it('propagates a changed token via a swap, preserving unique tracking', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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
      expect(h.mocks.log).toHaveBeenCalledWith(
        'run-proxy: restarting proxy — claude credentials changed',
      );
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
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.bringUpColor.mockClear();

      h.creds.value = { accessToken: 'A', expiresAt: 61 * MIN }; // only expiry moved
      h.fireCredentials();
      await flush();

      expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
    });

    it('keeps the old color serving (non-fatal) when the new color never becomes ready', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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

  describe('coalescing', () => {
    it('collapses events during an in-flight swap into exactly one follow-up swap', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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
      void runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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

  describe('refresh nudging', () => {
    it('exits non-zero after maxAttempts consecutive no-advance nudges', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
      const channel = claudeChannelConfig(h.creds, h.mocks, { maxAttempts: 3 });
      const exit = runProxyLoop(baseConfig([channel]), h.deps);
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
      const channel = claudeChannelConfig(h.creds, h.mocks, { maxAttempts: 3 });
      const exit = runProxyLoop(baseConfig([channel]), h.deps);
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

  describe('shutdown', () => {
    it('SIGINT tears everything down once and exits 0; a second SIGINT is a no-op', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
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

    it('SIGTERM tears everything down once and exits 0, same as SIGINT', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.log.mockClear();
      h.mocks.bringUpColor.mockClear();

      h.fireSigterm();
      h.fireSigterm();
      await flush();

      await expect(exit).resolves.toBe(0);
      const sigtermLogs = h.mocks.log.mock.calls.filter((c) => String(c[0]).includes('SIGTERM'));
      expect(sigtermLogs).toHaveLength(1);
      expect(h.mocks.watchClose).toHaveBeenCalledTimes(2);
      expect(h.mocks.stopLogStream).toHaveBeenCalled();
      expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
    });

    it('a SIGINT after a SIGTERM (or vice versa) is a no-op — only the first shutdown signal wins', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      h.fireSigterm();
      h.fireSigint();
      await flush();

      await expect(exit).resolves.toBe(0);
      const stopLogs = h.mocks.log.mock.calls.filter(
        (c) => String(c[0]).includes('SIGTERM') || String(c[0]).includes('SIGINT'),
      );
      expect(stopLogs).toHaveLength(1);
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
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush(); // parked in the startup waitColorReady

      h.fireSigint();
      await flush();

      await expect(exit).resolves.toBe(0);
      expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
    });
  });

  describe('multiple credential channels', () => {
    it('coalesces two dirty channels into one swap, writes both secrets, commits both', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const codexCreds = { value: { accessToken: 'X', expiresAt: 60 * MIN } as Credentials };
      const codexWrite = vi.fn();
      const codexChannel: CredentialChannelConfig = {
        name: 'codex',
        credentialsPath: '/fake/auth.json',
        secretPath: '/fake/codex-secret.yaml',
        readCredentials: () => codexCreds.value,
        writeSecret: codexWrite,
        nudgeRefresh: vi.fn().mockResolvedValue({ ok: true, stderr: '' }),
        refreshWindowMs: 3 * MIN,
        retryIntervalMs: 2 * MIN,
        maxAttempts: 3,
        refreshEnabled: true,
      };
      void runProxyLoop(baseConfig([h.channelConfig, codexChannel]), h.deps);
      await flush();
      h.mocks.bringUpColor.mockClear();
      h.mocks.writeSecret.mockClear();
      codexWrite.mockClear();

      // Block the in-flight swap so both credential events land mid-restart — the
      // window where the loop's coalescing guarantee actually applies (a pass's
      // dirty set is captured synchronously, before any awaited step; two watcher
      // callbacks fired back-to-back in the same tick land in *separate* passes
      // unless a restart is already in flight to hold them as pending).
      let release!: () => void;
      h.mocks.bringUpColor.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      h.fireAllowlist(); // swap begins; its bring-up is blocked
      await flush();
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

      // Both credentials change while the swap is in flight.
      h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
      codexCreds.value = { accessToken: 'Y', expiresAt: 60 * MIN };
      h.fireCredentials('/fake/.credentials.json');
      h.fireCredentials('/fake/auth.json');
      await flush();
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1); // still just the blocked one

      release();
      await flush();

      // One coalesced follow-up swap serves both credential changes.
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // blocked swap + one follow-up
      expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
      expect(codexWrite).toHaveBeenCalledWith('Y', '/fake/codex-secret.yaml');
      expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: swap complete — now serving blue');

      // Both are committed: presenting the same tokens again needs no further swap.
      h.mocks.bringUpColor.mockClear();
      h.fireCredentials('/fake/.credentials.json');
      h.fireCredentials('/fake/auth.json');
      await flush();
      expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
    });

    it('one channel exhausting its nudges fatals the whole loop and closes both watchers', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const codexChannel: CredentialChannelConfig = {
        name: 'codex',
        credentialsPath: '/fake/auth.json',
        secretPath: '/fake/codex-secret.yaml',
        readCredentials: () => ({ accessToken: 'X', expiresAt: 1 * MIN }),
        writeSecret: vi.fn(),
        nudgeRefresh: vi.fn().mockResolvedValue({ ok: false, stderr: 'codex boom' }),
        refreshWindowMs: 3 * MIN,
        retryIntervalMs: 2 * MIN,
        maxAttempts: 3,
        refreshEnabled: true,
      };
      const exit = runProxyLoop(baseConfig([h.channelConfig, codexChannel]), h.deps);
      await flush();

      // Codex's token is inside the refresh window and every nudge fails -> exhaustion.
      await vi.advanceTimersByTimeAsync(2 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('codex boom'));
      // Both credentials watchers + the allowlist watcher were closed (3 total).
      expect(h.mocks.watchClose).toHaveBeenCalledTimes(3);
    });
  });
});
