import { planNextActions } from './planNextActions';
import type { Credentials, NudgeResult, RefreshState } from './types';
import { describeExpiry, formatDuration, formatUtcClock } from './describeTime';

export interface CredentialChannelConfig {
  name: string;
  credentialsPath: string;
  secretPath: string;
  readCredentials: (path: string) => Credentials | null;
  writeSecret: (creds: Credentials, path: string) => void;
  nudgeRefresh: () => Promise<NudgeResult>;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
  /**
   * Brings anything outside the proxy that carries the account id in line with the host.
   * Called on the startup read, and again whenever a later read sees an account id
   * different from the last one synced successfully. Never called on a token/expiry-only
   * change or a failed read. Returns false on failure so the next read retries. The codex
   * channel uses it to rewrite the Codex CLI's placeholder mounts.
   */
  syncAccountId?: () => boolean;
}

export interface CredentialChannelDeps {
  now: () => number;
  /** Called when this channel exhausts maxAttempts consecutive failed nudges. */
  onExhausted: (message: string) => void;
  /** True once the loop has begun shutting down; the channel stops acting on async outcomes. */
  isSettled: () => boolean;
  /** Progress lines: the token's expiry at startup, a nudge firing, a nudge succeeding. */
  log: (message: string) => void;
  /** Problem lines: a nudge failing, or a nudge that did not refresh the token in time. */
  error: (message: string) => void;
}

export interface PrepareResult {
  restartNeeded: boolean;
  readable: boolean;
  /**
   * Set when restartNeeded: what changed and whether it followed one of our nudges, so
   * the restart line tells a nudge-driven refresh apart from one made outside run-hosting
   * (e.g. the user running claude on the host).
   */
  detail?: string;
}

/**
 * One credential source's full state machine, extracted verbatim from the old
 * Claude-only runHostingLoop: watched file -> secret write -> restart signalling, plus
 * the independent nudge timer / retry-backoff. The loop owns the blue-green restart;
 * a channel only decides *whether* a restart is needed and, after the swap succeeds,
 * commits its new token as applied.
 */
export class CredentialChannel {
  readonly name: string;
  readonly credentialsPath: string;

  private readonly config: CredentialChannelConfig;
  private readonly deps: CredentialChannelDeps;

  private lastAppliedToken: string | null = null;
  private lastAppliedAccountId: string | undefined;
  private lastSyncedAccountId: string | undefined;
  private lastSeenExpiresAt: number | null = null;
  private lastReadCreds: Credentials | null = null;
  private pendingToken: string | null = null;
  private pendingAccountId: string | undefined;
  private awaitingOutcome = false;
  private consecutiveFailures = 0;
  private lastNudgeAt: number | null = null;
  private lastNudgeStderr: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: CredentialChannelConfig, deps: CredentialChannelDeps) {
    this.config = config;
    this.deps = deps;
    this.name = config.name;
    this.credentialsPath = config.credentialsPath;
  }

  startupRead(): Credentials | null {
    const creds = this.config.readCredentials(this.config.credentialsPath);
    if (creds === null) return null;
    this.config.writeSecret(creds, this.config.secretPath);
    this.pendingToken = creds.accessToken;
    this.pendingAccountId = creds.accountId;
    this.lastReadCreds = creds;
    this.lastSeenExpiresAt = creds.expiresAt;
    this.syncAccountId(creds.accountId);
    this.deps.log(
      `run-hosting: ${this.name}: token ${describeExpiry(creds.expiresAt, this.deps.now())}`,
    );
    return creds;
  }

  prepareRestart(): PrepareResult {
    const creds = this.config.readCredentials(this.config.credentialsPath);
    if (creds === null) return { restartNeeded: false, readable: false };

    const advanced = this.lastSeenExpiresAt !== null && creds.expiresAt > this.lastSeenExpiresAt;
    const plan = planNextActions({
      creds,
      lastAppliedToken: this.lastAppliedToken,
      now: this.deps.now(),
      config: this.planConfig(),
      refresh: this.refreshState(),
    });

    let restartNeeded = false;
    let detail: string | undefined;
    const accountIdChanged = creds.accountId !== this.lastAppliedAccountId;
    if (plan.propagate || accountIdChanged) {
      this.config.writeSecret(creds, this.config.secretPath);
      this.pendingToken = creds.accessToken;
      this.pendingAccountId = creds.accountId;
      restartNeeded = true;
      detail = this.describeChange(creds, advanced);
    }
    // Compared against the last successful sync rather than what the proxy last
    // committed: the sync doesn't wait on a proxy swap, so a failed swap doesn't cause
    // repeated identical syncs, while a failed sync is retried on the next read.
    if (creds.accountId !== this.lastSyncedAccountId) this.syncAccountId(creds.accountId);
    if (advanced) {
      // Refresh landed: reset failure tracking and stop awaiting an outcome.
      this.consecutiveFailures = 0;
      this.awaitingOutcome = false;
    }
    this.lastReadCreds = creds;
    this.lastSeenExpiresAt = creds.expiresAt;
    return { restartNeeded, readable: true, detail };
  }

  /** Read before the advance resets awaitingOutcome, so it still knows a nudge was pending. */
  private describeChange(creds: Credentials, advanced: boolean): string {
    const expiry =
      advanced && this.lastSeenExpiresAt !== null
        ? `expiry ${formatUtcClock(this.lastSeenExpiresAt)} → ${formatUtcClock(creds.expiresAt)}`
        : `token ${describeExpiry(creds.expiresAt, this.deps.now())}`;
    const source = this.awaitingOutcome ? 'after a run-hosting nudge' : 'no nudge pending';
    return `${expiry}; ${source}`;
  }

  commit(): void {
    if (this.pendingToken !== null) {
      this.lastAppliedToken = this.pendingToken;
      this.pendingToken = null;
      this.lastAppliedAccountId = this.pendingAccountId;
      this.pendingAccountId = undefined;
    }
  }

  armTimer(): void {
    if (this.lastReadCreds === null) return;
    const plan = planNextActions({
      creds: this.lastReadCreds,
      lastAppliedToken: this.lastAppliedToken,
      now: this.deps.now(),
      config: this.planConfig(),
      refresh: this.refreshState(),
    });
    this.armAt(plan.nudgeAt);
  }

  clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private syncAccountId(accountId: string | undefined): void {
    if (this.config.syncAccountId?.() === true) this.lastSyncedAccountId = accountId;
  }

  private planConfig() {
    return {
      refreshWindowMs: this.config.refreshWindowMs,
      retryIntervalMs: this.config.retryIntervalMs,
    };
  }

  private refreshState(): RefreshState {
    return {
      enabled: this.config.refreshEnabled,
      awaitingOutcome: this.awaitingOutcome,
      lastNudgeAt: this.lastNudgeAt,
    };
  }

  private armAt(nudgeAt: number | null): void {
    this.clearTimer();
    if (nudgeAt === null) return;
    const delay = Math.max(0, nudgeAt - this.deps.now());
    this.timer = setTimeout(() => {
      void this.onTimer();
    }, delay);
  }

  private async onTimer(): Promise<void> {
    if (this.deps.isSettled()) return;
    if (this.awaitingOutcome) {
      // Outcome deadline reached with no observed advance -> failed attempt.
      this.handleFailedAttempt(
        `token was not refreshed within ${formatDuration(this.config.retryIntervalMs)} of the nudge`,
      );
    } else {
      await this.doNudge();
    }
  }

  private async doNudge(): Promise<void> {
    this.awaitingOutcome = true;
    this.lastNudgeAt = this.deps.now();
    // Arm the outcome deadline: retryInterval from now.
    this.armAt(this.lastNudgeAt + this.config.retryIntervalMs);
    const expiry = this.lastReadCreds
      ? `token ${describeExpiry(this.lastReadCreds.expiresAt, this.lastNudgeAt)}`
      : 'token expiry unknown';
    this.deps.log(`run-hosting: ${this.name}: nudging the CLI to refresh (${expiry})`);
    const result = await this.config.nudgeRefresh();
    if (this.deps.isSettled()) return;
    if (result.ok) {
      // A refresh the watcher already saw has cleared awaitingOutcome; only a pending one waits.
      this.deps.log(
        this.awaitingOutcome
          ? `run-hosting: ${this.name}: nudge succeeded; waiting up to ${formatDuration(this.config.retryIntervalMs)} for the refreshed token`
          : `run-hosting: ${this.name}: nudge succeeded`,
      );
    }
    if (!this.awaitingOutcome) return;
    if (result.ok) {
      this.lastNudgeStderr = null;
    } else {
      this.lastNudgeStderr = result.stderr;
      this.handleFailedAttempt(`nudge failed: ${summarizeStderr(result.stderr)}`);
    }
  }

  private handleFailedAttempt(reason: string): void {
    this.clearTimer();
    this.consecutiveFailures += 1;
    this.deps.error(
      `run-hosting: ${this.name}: ${reason} (attempt ${this.consecutiveFailures}/${this.config.maxAttempts})`,
    );
    if (this.consecutiveFailures >= this.config.maxAttempts) {
      this.deps.onExhausted(
        this.lastNudgeStderr ??
          `${this.name}: token did not refresh after ${this.config.maxAttempts} attempts`,
      );
      return;
    }
    void this.doNudge();
  }
}

/** One line of the nudge's stderr, bounded, for the per-attempt failure line. */
function summarizeStderr(stderr: string): string {
  const flat = stderr.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'the CLI exited non-zero with no stderr';
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}
