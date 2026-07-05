import { planNextActions } from './planNextActions';
import type { Credentials, NudgeResult, RefreshState } from './types';

export interface RunProxyConfig {
  credentialsPath: string;
  secretPath: string;
  serviceName: string;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
}

export interface RunProxyDeps {
  readCredentials: (path: string) => Credentials | null;
  writeSecret: (token: string, path: string) => void;
  recreateContainer: (serviceName: string) => Promise<void>;
  nudgeRefresh: () => Promise<NudgeResult>;
  watch: (credentialsPath: string, onEvent: () => void) => { close: () => void };
  onSigint: (handler: () => void) => void;
  log: (message: string) => void;
  error: (message: string) => void;
  now: () => number;
}

/**
 * Long-running orchestrator. Resolves with a process exit code: 0 on SIGINT
 * (container left running under its restart policy), 1 on any fatal error.
 */
export function runProxyLoop(config: RunProxyConfig, deps: RunProxyDeps): Promise<number> {
  return new Promise<number>((resolve) => {
    let lastAppliedToken: string | null = null;
    let lastSeenExpiresAt: number | null = null;
    let lastNudgeAt: number | null = null;
    let lastNudgeStderr: string | null = null;
    let awaitingOutcome = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcherHandle: { close: () => void } | null = null;
    let settled = false;

    const planConfig = {
      refreshWindowMs: config.refreshWindowMs,
      retryIntervalMs: config.retryIntervalMs,
    };

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      watcherHandle?.close();
      resolve(code);
    };

    const fatal = (message: string): void => {
      if (settled) return;
      deps.error(`run-proxy: ${message}`);
      settle(1);
    };

    const refreshState = (): RefreshState => ({
      enabled: config.refreshEnabled,
      awaitingOutcome,
      lastNudgeAt,
    });

    const armTimer = (nudgeAt: number | null): void => {
      clearTimer();
      if (nudgeAt === null) return;
      const delay = Math.max(0, nudgeAt - deps.now());
      timer = setTimeout(() => {
        void onTimer();
      }, delay);
    };

    const recreateWithOneRetry = async (): Promise<boolean> => {
      try {
        await deps.recreateContainer(config.serviceName);
        return true;
      } catch {
        try {
          await deps.recreateContainer(config.serviceName);
          return true;
        } catch {
          return false;
        }
      }
    };

    const handleFailedAttempt = (): void => {
      clearTimer();
      consecutiveFailures += 1;
      if (consecutiveFailures >= config.maxAttempts) {
        fatal(lastNudgeStderr ?? `token did not refresh after ${config.maxAttempts} attempts`);
        return;
      }
      void doNudge();
    };

    const doNudge = async (): Promise<void> => {
      awaitingOutcome = true;
      lastNudgeAt = deps.now();
      // Arm the outcome deadline: retryInterval from now.
      armTimer(lastNudgeAt + config.retryIntervalMs);
      const result = await deps.nudgeRefresh();
      if (settled || !awaitingOutcome) return;
      if (result.ok) {
        lastNudgeStderr = null;
      } else {
        lastNudgeStderr = result.stderr;
        handleFailedAttempt();
      }
    };

    const onTimer = async (): Promise<void> => {
      if (settled) return;
      if (awaitingOutcome) {
        // Outcome deadline reached with no observed advance -> failed attempt.
        handleFailedAttempt();
      } else {
        await doNudge();
      }
    };

    const onWatcherEvent = async (): Promise<void> => {
      if (settled) return;
      const creds = deps.readCredentials(config.credentialsPath);
      if (creds === null) {
        deps.error('run-proxy: skipped credentials event (unreadable or partial write)');
        return;
      }

      const advanced = lastSeenExpiresAt !== null && creds.expiresAt > lastSeenExpiresAt;

      const plan = planNextActions({
        creds,
        lastAppliedToken,
        now: deps.now(),
        config: planConfig,
        refresh: refreshState(),
      });

      if (plan.propagate) {
        deps.writeSecret(creds.accessToken, config.secretPath);
        const ok = await recreateWithOneRetry();
        if (settled) return;
        if (!ok) {
          fatal('docker failed to recreate the container while propagating a new token');
          return;
        }
        lastAppliedToken = creds.accessToken;
      }

      if (advanced) {
        // Refresh landed: reset failure tracking and stop awaiting an outcome.
        consecutiveFailures = 0;
        awaitingOutcome = false;
      }
      lastSeenExpiresAt = creds.expiresAt;

      const nextPlan = planNextActions({
        creds,
        lastAppliedToken,
        now: deps.now(),
        config: planConfig,
        refresh: refreshState(),
      });
      armTimer(nextPlan.nudgeAt);
    };

    const start = async (): Promise<void> => {
      const creds = deps.readCredentials(config.credentialsPath);
      if (creds === null) {
        fatal(`could not read credentials at ${config.credentialsPath}`);
        return;
      }

      deps.writeSecret(creds.accessToken, config.secretPath);
      try {
        await deps.recreateContainer(config.serviceName);
      } catch {
        fatal('docker failed to recreate the container on startup');
        return;
      }
      if (settled) return;

      lastAppliedToken = creds.accessToken;
      lastSeenExpiresAt = creds.expiresAt;

      watcherHandle = deps.watch(config.credentialsPath, () => {
        void onWatcherEvent();
      });
      deps.onSigint(() => {
        deps.log('run-proxy: SIGINT received, stopping (container left running)');
        settle(0);
      });

      const plan = planNextActions({
        creds,
        lastAppliedToken,
        now: deps.now(),
        config: planConfig,
        refresh: refreshState(),
      });
      armTimer(plan.nudgeAt);
      deps.log('run-proxy: watching credentials; proxy is serving the current token');
    };

    void start();
  });
}
