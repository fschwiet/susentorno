import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CredentialChannel,
  type CredentialChannelConfig,
  type CredentialChannelDeps,
} from '../../src/runProxy/credentialChannel';
import type { Credentials } from '../../src/runProxy/types';

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
      expect(mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/secret.yaml');
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
      expect(channel.prepareRestart()).toEqual({ restartNeeded: true, readable: true });
      expect(mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/secret.yaml');
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
