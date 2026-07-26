import { describe, it, expect } from 'vitest';
import { planNextActions } from '../../src/runProxy/planNextActions';
import type { PlanInput } from '../../src/runProxy/types';

const MIN = 60_000;

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    creds: { accessToken: 'token-A', expiresAt: 1_000_000 },
    lastAppliedToken: 'token-A',
    now: 0,
    config: { refreshWindowMs: 3 * MIN, retryIntervalMs: 2 * MIN },
    refresh: { enabled: true, awaitingOutcome: false, lastNudgeAt: null },
    ...overrides,
  };
}

describe('supervision planning', () => {
  it('does not propagate when the token is unchanged', () => {
    expect(planNextActions(input()).propagate).toBe(false);
  });

  it('propagates when the token differs from the last applied one', () => {
    const result = planNextActions(
      input({
        creds: { accessToken: 'token-B', expiresAt: 1_000_000 },
        lastAppliedToken: 'token-A',
      }),
    );
    expect(result.propagate).toBe(true);
  });

  it('arms the nudge at expiresAt - refreshWindow when expiry is far out', () => {
    const result = planNextActions(
      input({ now: 0, creds: { accessToken: 'token-A', expiresAt: 10 * MIN } }),
    );
    expect(result.nudgeAt).toBe(10 * MIN - 3 * MIN);
  });

  it('arms the nudge at now when expiry is already within the refresh window', () => {
    const result = planNextActions(
      input({ now: 8 * MIN, creds: { accessToken: 'token-A', expiresAt: 10 * MIN } }),
    );
    expect(result.nudgeAt).toBe(8 * MIN);
  });

  it('arms the nudge at now when the token is already expired', () => {
    const result = planNextActions(
      input({ now: 20 * MIN, creds: { accessToken: 'token-A', expiresAt: 10 * MIN } }),
    );
    expect(result.nudgeAt).toBe(20 * MIN);
  });

  it('arms the retry deadline when a nudge is awaiting an outcome', () => {
    const result = planNextActions(
      input({
        now: 5 * MIN,
        refresh: { enabled: true, awaitingOutcome: true, lastNudgeAt: 4 * MIN },
      }),
    );
    expect(result.nudgeAt).toBe(4 * MIN + 2 * MIN);
  });

  it('returns nudgeAt null when refresh is disabled', () => {
    const result = planNextActions(
      input({ refresh: { enabled: false, awaitingOutcome: false, lastNudgeAt: null } }),
    );
    expect(result.nudgeAt).toBeNull();
  });
});
