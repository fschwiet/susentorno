/**
 * Time formatting for run-hosting's own log lines. Clock times are UTC (with a `Z`) to
 * line up with the access-log lines, whose timestamps are Envoy's UTC start times.
 */

/** `HH:MM:SSZ` for an epoch-ms instant. */
export function formatUtcClock(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 19)}Z`;
}

/** Compact non-negative duration: `7h59m`, `2m59s`, `45s`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** `expires 01:32:05Z, in 7h59m` or `expired 17:32:05Z, 4m0s ago`. */
export function describeExpiry(expiresAt: number, now: number): string {
  const clock = formatUtcClock(expiresAt);
  return expiresAt > now
    ? `expires ${clock}, in ${formatDuration(expiresAt - now)}`
    : `expired ${clock}, ${formatDuration(now - expiresAt)} ago`;
}
