import type { PlanInput, PlanResult } from './types';

/**
 * Pure decision core. No I/O — all timing is derived from `now`, `creds.expiresAt`,
 * and `refresh`, so it is exhaustively unit-testable.
 */
export function planNextActions({
  creds,
  lastAppliedToken,
  now,
  config,
  refresh,
}: PlanInput): PlanResult {
  const propagate = creds.accessToken !== lastAppliedToken;

  if (!refresh.enabled) {
    return { propagate, nudgeAt: null };
  }

  // A nudge is in flight and its outcome hasn't been observed: the timer's job is
  // the retry/outcome deadline, retryInterval after the nudge fired.
  if (refresh.awaitingOutcome && refresh.lastNudgeAt !== null) {
    return { propagate, nudgeAt: refresh.lastNudgeAt + config.retryIntervalMs };
  }

  // Normal case: nudge refreshWindow before expiry, or immediately if that point
  // is already past (within-window or expired).
  const target = creds.expiresAt - config.refreshWindowMs;
  return { propagate, nudgeAt: target <= now ? now : target };
}
