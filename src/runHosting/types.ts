export interface Credentials {
  /** OAuth access token injected into the VM's requests. */
  accessToken: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
  /**
   * Real account id for the codex host-credential channel, injected into the
   * `chatgpt-account-id` header at the proxy. Only `readCodexCredentials` populates
   * this; Claude's `readCredentials` leaves it `undefined`.
   */
  accountId?: string;
}

export interface RefreshState {
  /** False when the user passed --no-refresh: never nudge. */
  enabled: boolean;
  /** True between firing a nudge and observing its outcome. */
  awaitingOutcome: boolean;
  /** When the most recent nudge fired, epoch ms; null before the first nudge. */
  lastNudgeAt: number | null;
}

export interface PlanConfig {
  refreshWindowMs: number;
  retryIntervalMs: number;
}

export interface PlanInput {
  creds: Credentials;
  lastAppliedToken: string | null;
  now: number;
  config: PlanConfig;
  refresh: RefreshState;
}

export interface PlanResult {
  /** Envoy must be updated: the credential differs from what we last applied. */
  propagate: boolean;
  /** Absolute time (epoch ms) to arm the nudge timer, or null when refresh is disabled. */
  nudgeAt: number | null;
}

export interface NudgeResult {
  /** True when the `claude` process exited 0. Does NOT mean the token refreshed. */
  ok: boolean;
  /** Captured stderr when the process errored; empty string otherwise. */
  stderr: string;
}

export type Color = 'blue' | 'green';

export interface ColorPorts {
  httpsPort: number;
  httpPort: number;
  adminPort: number;
}

export function otherColor(color: Color): Color {
  return color === 'blue' ? 'green' : 'blue';
}
