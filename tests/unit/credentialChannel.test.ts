import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CredentialChannel,
  type CredentialChannelConfig,
  type CredentialChannelDeps,
} from '../../src/runHosting/credentialChannel';
import type { Credentials } from '../../src/runHosting/types';

const MIN = 60_000;

function makeChannel(
  initial: Credentials,
  overrides: Partial<CredentialChannelConfig> = {},
  depsOverrides: Partial<CredentialChannelDeps> = {},
) {
  const creds = { value: initial as Credentials | null };
  const mocks = {
    readCredentials: vi.fn(() => creds.value),
    writeSecret: vi.fn(),
    nudgeRefresh: vi.fn().mockResolvedValue({ ok: true, stderr: '' }),
    onExhausted: vi.fn(),
    log: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  };
  const config: CredentialChannelConfig = {
    name: 'test',
    credentialsPath: '/fake/creds',
    secretPath: '/fake/secret.yaml',
    readCredentials: mocks.readCredentials,
    writeSecret: mocks.writeSecret,
    nudgeRefresh: mocks.nudgeRefresh,
    refreshWindowMs: 3 * MIN,
    retryIntervalMs: 2 * MIN,
    maxAttempts: 3,
    refreshEnabled: true,
    ...overrides,
  };
  const deps: CredentialChannelDeps = {
    now: () => Date.now(),
    onExhausted: mocks.onExhausted,
    isSettled: () => false,
    log: mocks.log,
    error: mocks.error,
    ...depsOverrides,
  };
  return { channel: new CredentialChannel(config, deps), creds, mocks };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('credential channel lifecycle', () => {
  describe('startup + propagation', () => {
    it('startupRead writes the secret and stages the token; commit makes it applied', () => {
      const { channel, mocks } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
      expect(channel.startupRead()).toEqual({ accessToken: 'A', expiresAt: 60 * MIN });
      expect(mocks.writeSecret).toHaveBeenCalledWith(
        { accessToken: 'A', expiresAt: 60 * MIN },
        '/fake/secret.yaml',
      );
      channel.commit();

      // Same token after commit -> no restart.
      expect(channel.prepareRestart()).toEqual({ restartNeeded: false, readable: true });
    });

    it('startupRead returns null when the file is unreadable', () => {
      const { channel, creds } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
      creds.value = null;
      expect(channel.startupRead()).toBeNull();
    });

    it('prepareRestart writes + stages a changed token and needs a restart', () => {
      const { channel, creds, mocks } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
      channel.startupRead();
      channel.commit();
      mocks.writeSecret.mockClear();

      creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
      expect(channel.prepareRestart()).toEqual({
        restartNeeded: true,
        readable: true,
        detail: expect.any(String),
      });
      expect(mocks.writeSecret).toHaveBeenCalledWith(
        { accessToken: 'B', expiresAt: 60 * MIN },
        '/fake/secret.yaml',
      );
    });

    it('prepareRestart reports unreadable without a restart', () => {
      const { channel, creds } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
      channel.startupRead();
      channel.commit();
      creds.value = null;
      expect(channel.prepareRestart()).toEqual({ restartNeeded: false, readable: false });
    });

    it('does not need a restart when only expiry moves (same token)', () => {
      const { channel, creds } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
      channel.startupRead();
      channel.commit();
      creds.value = { accessToken: 'A', expiresAt: 90 * MIN };
      expect(channel.prepareRestart().restartNeeded).toBe(false);
    });

    it('propagates when account id changes with the same access token', () => {
      const { channel, creds, mocks } = makeChannel({
        accessToken: 'A',
        expiresAt: 60 * MIN,
        accountId: 'acct-1',
      });
      channel.startupRead();
      channel.commit();
      mocks.writeSecret.mockClear();

      creds.value = { accessToken: 'A', expiresAt: 60 * MIN, accountId: 'acct-2' };
      expect(channel.prepareRestart()).toEqual({
        restartNeeded: true,
        readable: true,
        detail: expect.any(String),
      });
      expect(mocks.writeSecret).toHaveBeenCalledWith(
        { accessToken: 'A', expiresAt: 60 * MIN, accountId: 'acct-2' },
        '/fake/secret.yaml',
      );
    });
  });

  describe('account id sync hook', () => {
    it('fires once on the startup read', () => {
      const syncAccountId = vi.fn(() => true);
      const { channel } = makeChannel(
        { accessToken: 'A', expiresAt: 60 * MIN, accountId: 'acct-1' },
        { syncAccountId },
      );
      channel.startupRead();
      expect(syncAccountId).toHaveBeenCalledTimes(1);
    });

    it('fires again when a later read has a different account id', () => {
      const syncAccountId = vi.fn(() => true);
      const { channel, creds } = makeChannel(
        { accessToken: 'A', expiresAt: 60 * MIN, accountId: 'acct-1' },
        { syncAccountId },
      );
      channel.startupRead();
      channel.commit();
      syncAccountId.mockClear();

      creds.value = { accessToken: 'A', expiresAt: 60 * MIN, accountId: 'acct-2' };
      channel.prepareRestart();
      expect(syncAccountId).toHaveBeenCalledTimes(1);
    });

    it('does not fire when only the token or expiry changes', () => {
      const syncAccountId = vi.fn(() => true);
      const { channel, creds } = makeChannel(
        { accessToken: 'A', expiresAt: 60 * MIN, accountId: 'acct-1' },
        { syncAccountId },
      );
      channel.startupRead();
      channel.commit();
      syncAccountId.mockClear();

      creds.value = { accessToken: 'B', expiresAt: 60 * MIN, accountId: 'acct-1' };
      channel.prepareRestart();
      channel.commit();
      creds.value = { accessToken: 'B', expiresAt: 90 * MIN, accountId: 'acct-1' };
      channel.prepareRestart();
      expect(syncAccountId).not.toHaveBeenCalled();
    });

    it('fires again on the next read after a failed sync, until one succeeds', () => {
      const syncAccountId = vi.fn(() => false);
      const { channel } = makeChannel(
        { accessToken: 'A', expiresAt: 60 * MIN, accountId: 'acct-1' },
        { syncAccountId },
      );
      channel.startupRead();
      channel.commit();
      channel.prepareRestart();
      expect(syncAccountId).toHaveBeenCalledTimes(2);

      syncAccountId.mockReturnValue(true);
      channel.prepareRestart();
      channel.prepareRestart();
      expect(syncAccountId).toHaveBeenCalledTimes(3);
    });

    it('does not fire when a read fails', () => {
      const syncAccountId = vi.fn(() => true);
      const { channel, creds } = makeChannel(
        { accessToken: 'A', expiresAt: 60 * MIN, accountId: 'acct-1' },
        { syncAccountId },
      );
      creds.value = null;
      channel.startupRead();
      expect(syncAccountId).not.toHaveBeenCalled();

      creds.value = { accessToken: 'A', expiresAt: 60 * MIN, accountId: 'acct-1' };
      channel.startupRead();
      channel.commit();
      syncAccountId.mockClear();
      creds.value = null;
      channel.prepareRestart();
      expect(syncAccountId).not.toHaveBeenCalled();
    });
  });

  describe('refresh nudging', () => {
    it('exits via onExhausted after maxAttempts consecutive no-advance nudges', async () => {
      const { channel, mocks } = makeChannel({ accessToken: 'A', expiresAt: 1 * MIN });
      channel.startupRead();
      channel.commit();
      channel.armTimer(); // expiry within refresh window -> nudge immediately

      await vi.advanceTimersByTimeAsync(2 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);

      expect(mocks.nudgeRefresh).toHaveBeenCalledTimes(3);
      expect(mocks.onExhausted).toHaveBeenCalledTimes(1);
      expect(mocks.onExhausted.mock.calls[0][0]).toContain('did not refresh after 3 attempts');
    });

    it('resets the failure counter when a refreshed (advanced-expiry) token appears', async () => {
      const { channel, creds, mocks } = makeChannel({ accessToken: 'A', expiresAt: 1 * MIN });
      channel.startupRead();
      channel.commit();
      channel.armTimer();
      await vi.advanceTimersByTimeAsync(2 * MIN); // one failed-outcome cycle in flight

      creds.value = { accessToken: 'A', expiresAt: 90 * MIN }; // refresh landed (advanced)
      channel.prepareRestart();
      channel.armTimer();

      await vi.advanceTimersByTimeAsync(80 * MIN);
      expect(mocks.onExhausted).not.toHaveBeenCalled();
    });

    it('never nudges when refresh is disabled', async () => {
      const { channel, mocks } = makeChannel(
        { accessToken: 'A', expiresAt: 1 * MIN },
        { refreshEnabled: false },
      );
      channel.startupRead();
      channel.commit();
      channel.armTimer();
      await vi.advanceTimersByTimeAsync(10 * MIN);
      expect(mocks.nudgeRefresh).not.toHaveBeenCalled();
    });
  });

  describe('diagnostic logging', () => {
    it('logs the token expiry on the startup read', () => {
      const { channel, mocks } = makeChannel({ accessToken: 'A', expiresAt: 90 * MIN });
      channel.startupRead();
      expect(mocks.log).toHaveBeenCalledWith(
        'run-hosting: test: token expires 01:30:00Z, in 1h30m',
      );
    });

    it('logs a nudge firing and succeeding', async () => {
      const { channel, mocks } = makeChannel({ accessToken: 'A', expiresAt: 2 * MIN });
      channel.startupRead();
      channel.commit();
      channel.armTimer(); // within the refresh window -> nudge now
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.log).toHaveBeenCalledWith(
        'run-hosting: test: nudging the CLI to refresh (token expires 00:02:00Z, in 2m0s)',
      );
      expect(mocks.log).toHaveBeenCalledWith(
        'run-hosting: test: nudge succeeded; waiting up to 2m0s for the refreshed token',
      );
      expect(mocks.error).not.toHaveBeenCalled();
    });

    it('logs a failed nudge with its stderr and attempt count', async () => {
      const { channel, mocks } = makeChannel({ accessToken: 'A', expiresAt: 2 * MIN });
      mocks.nudgeRefresh.mockResolvedValueOnce({ ok: false, stderr: 'boom\n  second line\n' });
      channel.startupRead();
      channel.commit();
      channel.armTimer();
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.error).toHaveBeenCalledWith(
        'run-hosting: test: nudge failed: boom second line (attempt 1/3)',
      );
    });

    it('logs a nudge whose token never arrived', async () => {
      const { channel, mocks } = makeChannel({ accessToken: 'A', expiresAt: 2 * MIN });
      channel.startupRead();
      channel.commit();
      channel.armTimer();
      await vi.advanceTimersByTimeAsync(2 * MIN);

      expect(mocks.error).toHaveBeenCalledWith(
        'run-hosting: test: token was not refreshed within 2m0s of the nudge (attempt 1/3)',
      );
    });

    it('attributes a refresh to a pending nudge', async () => {
      const { channel, creds } = makeChannel({ accessToken: 'A', expiresAt: 2 * MIN });
      channel.startupRead();
      channel.commit();
      channel.armTimer();
      await vi.advanceTimersByTimeAsync(0);

      creds.value = { accessToken: 'B', expiresAt: 482 * MIN };
      expect(channel.prepareRestart().detail).toBe(
        'expiry 00:02:00Z → 08:02:00Z; after a run-hosting nudge',
      );
    });

    it('attributes a refresh with no nudge pending to something outside run-hosting', () => {
      const { channel, creds } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
      channel.startupRead();
      channel.commit();
      channel.armTimer(); // far from expiry: no nudge yet

      creds.value = { accessToken: 'B', expiresAt: 540 * MIN };
      expect(channel.prepareRestart().detail).toBe(
        'expiry 01:00:00Z → 09:00:00Z; no nudge pending',
      );
    });

    it('describes a token change whose expiry did not advance', () => {
      const { channel, creds } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
      channel.startupRead();
      channel.commit();

      creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
      expect(channel.prepareRestart().detail).toBe(
        'token expires 01:00:00Z, in 1h0m; no nudge pending',
      );
    });
  });

  describe('isolation between two channels', () => {
    it('one channel exhausting does not touch the other channel timer/backoff', async () => {
      const a = makeChannel({ accessToken: 'A', expiresAt: 1 * MIN }, { name: 'claude' });
      const b = makeChannel({ accessToken: 'B', expiresAt: 60 * MIN }, { name: 'codex' });
      for (const h of [a, b]) {
        h.channel.startupRead();
        h.channel.commit();
        h.channel.armTimer();
      }

      // Drive A to exhaustion; B's token is far from expiry so it never nudges.
      await vi.advanceTimersByTimeAsync(2 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);

      expect(a.mocks.onExhausted).toHaveBeenCalledTimes(1);
      expect(b.mocks.onExhausted).not.toHaveBeenCalled();
      expect(b.mocks.nudgeRefresh).not.toHaveBeenCalled();
    });
  });
});
