import { planNextActions } from './planNextActions';
import type { Credentials, NudgeResult, RefreshState } from './types';

export interface CredentialChannelConfig {
  name: string;
  credentialsPath: string;
  secretPath: string;
  readCredentials: (path: string) => Credentials | null;
  writeSecret: (token: string, path: string) => void;
  nudgeRefresh: () => Promise<NudgeResult>;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
}

export interface CredentialChannelDeps {
  now: () => number;
  /** Called when this channel exhausts maxAttempts consecutive failed nudges. */
  onExhausted: (message: string) => void;
  /** True once the loop has begun shutting down; the channel stops acting on async outcomes. */
  isSettled: () => boolean;
}

export interface PrepareResult {
  restartNeeded: boolean;
  readable: boolean;
}

/**
 * One credential source's full state machine, extracted verbatim from the old
 * Claude-only runProxyLoop: watched file -> secret write -> restart signalling, plus
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
  private lastSeenExpiresAt: number | null = null;
  private lastReadCreds: Credentials | null = null;
  private pendingToken: string | null = null;
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
    this.config.writeSecret(creds.accessToken, this.config.secretPath);
    this.pendingToken = creds.accessToken;
    this.lastReadCreds = creds;
    this.lastSeenExpiresAt = creds.expiresAt;
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
    if (plan.propagate) {
      this.config.writeSecret(creds.accessToken, this.config.secretPath);
      this.pendingToken = creds.accessToken;
      restartNeeded = true;
    }
    if (advanced) {
      // Refresh landed: reset failure tracking and stop awaiting an outcome.
      this.consecutiveFailures = 0;
      this.awaitingOutcome = false;
    }
    this.lastReadCreds = creds;
    this.lastSeenExpiresAt = creds.expiresAt;
    return { restartNeeded, readable: true };
  }

  commit(): void {
    if (this.pendingToken !== null) {
      this.lastAppliedToken = this.pendingToken;
      this.pendingToken = null;
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
      this.handleFailedAttempt();
    } else {
      await this.doNudge();
    }
  }

  private async doNudge(): Promise<void> {
    this.awaitingOutcome = true;
    this.lastNudgeAt = this.deps.now();
    // Arm the outcome deadline: retryInterval from now.
    this.armAt(this.lastNudgeAt + this.config.retryIntervalMs);
    const result = await this.config.nudgeRefresh();
    if (this.deps.isSettled() || !this.awaitingOutcome) return;
    if (result.ok) {
      this.lastNudgeStderr = null;
    } else {
      this.lastNudgeStderr = result.stderr;
      this.handleFailedAttempt();
    }
  }

  private handleFailedAttempt(): void {
    this.clearTimer();
    this.consecutiveFailures += 1;
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
