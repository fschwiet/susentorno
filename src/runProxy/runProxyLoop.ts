import { planNextActions } from './planNextActions';
import { parseAllowlist, terminateTlsHosts, type Allowlist } from '../allowlist';
import { parseLine } from './parseLine';
import { classify } from './classify';
import { formatOutput } from './formatOutput';
import { UniqueTracker } from './uniqueTracker';
import type { Credentials, NudgeResult, RefreshState, Color, ColorPorts } from './types';
import { otherColor } from './types';
import type { WaitResult } from './waitColorReady';

export interface RunProxyConfig {
  credentialsPath: string;
  allowlistPath: string;
  secretPath: string;
  /** How long to wait for a freshly-started color's admin /ready before giving up. */
  readyTimeoutMs: number;
  /** How long to let the old color's connections finish before force-closing them. */
  drainTimeoutMs: number;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
}

export interface RunProxyDeps {
  readCredentials: (path: string) => Credentials | null;
  /** Raw allowlist file content, or null when unreadable. */
  readAllowlist: (path: string) => string | null;
  writeSecret: (token: string, path: string) => void;
  /** Render and write envoy.yaml (upstream overrides are baked in by the caller). */
  buildConfig: (allowlist: Allowlist) => void;
  /** Ensure the leaf covers `sans` (reissue if needed); returns a status line. */
  ensureLeaf: (sans: string[]) => string;
  /** Allocate three distinct free loopback ports for the next color to bring up. */
  allocatePorts: () => Promise<ColorPorts>;
  /** Force-recreate the given color's container, published on `ports`. */
  bringUpColor: (color: Color, ports: ColorPorts) => Promise<void>;
  /** Poll the color's own admin /ready; ready once it serves, else exited/timeout. */
  waitColorReady: (
    color: Color,
    ports: ColorPorts,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<WaitResult>;
  /** Point the gateway forwarder at this color's backend ports (the flip). */
  setActiveBackend: (ports: ColorPorts) => void;
  /** Wait for the old color's connections to drain, force-closing at timeout. */
  drainBackend: (ports: ColorPorts, timeoutMs: number, signal: AbortSignal) => Promise<void>;
  /** Stop the given color's container. */
  stopColor: (color: Color) => Promise<void>;
  nudgeRefresh: () => Promise<NudgeResult>;
  /** File watcher; used for both the credentials file and the allowlist. */
  watch: (path: string, onEvent: () => void) => { close: () => void };
  startLogStream: (color: Color, onLine: (raw: string) => void) => void;
  /** Resolves once the current log-follow child is fully gone; no-op when none. */
  stopLogStream: () => Promise<void>;
  onSigint: (handler: () => void) => void;
  log: (message: string) => void;
  error: (message: string) => void;
  now: () => number;
}

/**
 * Long-running orchestrator. Owns the proxy end to end: builds envoy.yaml from
 * the allowlist, keeps the SDS secret fresh, watches both files, restarts the
 * container on changes (serialized, coalescing bursts), and streams the tagged
 * access log inline (each host+handling once). Resolves with a process exit
 * code: 0 on SIGINT (container left running), 1 on any fatal error.
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
    let credentialsWatcher: { close: () => void } | null = null;
    let allowlistWatcher: { close: () => void } | null = null;
    let settled = false;
    let restarting = false;
    let pendingCredentials = false;
    let pendingAllowlist = false;
    let sigintSeen = false;
    let activeColor: Color = 'blue';
    let activePorts: ColorPorts | null = null;
    const unique = new UniqueTracker();
    const shutdownAbort = new AbortController();

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

    /**
     * Tear down every long-lived handle, then resolve. `settled` flips
     * synchronously so no callback can act after shutdown begins; the log
     * child is stopped asynchronously before resolving so it cannot outlive us.
     */
    const shutdown = (code: number): void => {
      if (settled) return;
      settled = true;
      shutdownAbort.abort();
      clearTimer();
      credentialsWatcher?.close();
      allowlistWatcher?.close();
      void deps.stopLogStream().then(() => resolve(code));
    };

    const fatal = (message: string): void => {
      if (settled) return;
      deps.error(`run-proxy: ${message}`);
      shutdown(1);
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

    const onLogLine = (raw: string): void => {
      if (settled) return;
      const access = parseLine(raw);
      if (!access) return;
      for (const entry of classify(access)) {
        if (!unique.shouldPrint(entry)) continue;
        deps.log(formatOutput(entry));
      }
    };

    /** Read+parse the allowlist; null only when the file is unreadable (keep previous config). */
    const readParsedAllowlist = (): Allowlist | null => {
      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        deps.error(
          `run-proxy: could not read allowlist at ${config.allowlistPath}, keeping previous config`,
        );
        return null;
      }
      const allowlist = parseAllowlist(content);
      for (const warning of allowlist.warnings) deps.error(`run-proxy: ${warning}`);
      return allowlist;
    };

    /** Reissue the leaf if the terminate hosts changed and rewrite envoy.yaml. */
    const applyAllowlist = (allowlist: Allowlist): void => {
      deps.log(`run-proxy: ${deps.ensureLeaf(terminateTlsHosts(allowlist))}`);
      deps.buildConfig(allowlist);
    };

    const requestRestart = (source: 'credentials' | 'allowlist'): void => {
      if (settled) return;
      if (source === 'credentials') pendingCredentials = true;
      else pendingAllowlist = true;
      if (!restarting) void drainRestarts();
    };

    /**
     * Serialized restart pipeline: at most one force-recreate runs at a time.
     * Events landing mid-restart only set pending flags; the while loop then
     * collapses any burst into a single follow-up restart that re-reads both
     * files fresh, so the final state always reflects the latest files.
     */
    const drainRestarts = async (): Promise<void> => {
      restarting = true;
      try {
        while (!settled && (pendingCredentials || pendingAllowlist)) {
          const credentialsDirty = pendingCredentials;
          const allowlistDirty = pendingAllowlist;
          pendingCredentials = false;
          pendingAllowlist = false;

          let restartNeeded = false;
          let clearUnique = false;
          const reasons: string[] = [];

          if (allowlistDirty) {
            const allowlist = readParsedAllowlist();
            if (allowlist !== null) {
              try {
                applyAllowlist(allowlist);
              } catch (err) {
                fatal(`failed to rebuild the proxy config: ${String(err)}`);
                return;
              }
              restartNeeded = true;
              clearUnique = true; // wholesale reset, per design
              reasons.push('allowlist changed');
            }
          }

          let latestCreds: Credentials | null = null;
          let tokenToApply: string | null = null;
          if (credentialsDirty) {
            latestCreds = deps.readCredentials(config.credentialsPath);
            if (latestCreds === null) {
              deps.error('run-proxy: skipped credentials event (unreadable or partial write)');
            } else {
              const advanced =
                lastSeenExpiresAt !== null && latestCreds.expiresAt > lastSeenExpiresAt;
              const plan = planNextActions({
                creds: latestCreds,
                lastAppliedToken,
                now: deps.now(),
                config: planConfig,
                refresh: refreshState(),
              });
              if (plan.propagate) {
                deps.writeSecret(latestCreds.accessToken, config.secretPath);
                tokenToApply = latestCreds.accessToken;
                restartNeeded = true;
                reasons.push('credentials changed');
              }
              if (advanced) {
                // Refresh landed: reset failure tracking and stop awaiting an outcome.
                consecutiveFailures = 0;
                awaitingOutcome = false;
              }
              lastSeenExpiresAt = latestCreds.expiresAt;
            }
          }

          if (restartNeeded && activePorts !== null) {
            deps.log(`run-proxy: restarting proxy — ${reasons.join(', ')}`);
            const idle = otherColor(activeColor);
            const oldColor = activeColor;
            const oldPorts = activePorts;

            const idlePorts = await deps.allocatePorts();
            let broughtUp = true;
            try {
              await deps.bringUpColor(idle, idlePorts);
            } catch (err) {
              broughtUp = false;
              deps.error(
                `run-proxy: could not start the new proxy (${idle}) — keeping the current proxy: ${String(err)}`,
              );
            }
            if (settled) return;

            if (broughtUp) {
              const result = await deps.waitColorReady(
                idle,
                idlePorts,
                config.readyTimeoutMs,
                shutdownAbort.signal,
              );
              if (settled) return;
              if (!result.ready) {
                deps.error(
                  result.reason === 'exited'
                    ? `run-proxy: new proxy (${idle}) exited during startup — likely config issue, check the logs`
                    : `run-proxy: new proxy (${idle}) did not become ready — keeping the current proxy`,
                );
                await deps.stopColor(idle).catch(() => {});
              } else {
                // Flip: new connections now go to the freshly-ready color.
                await deps.stopLogStream();
                deps.setActiveBackend(idlePorts);
                activeColor = idle;
                activePorts = idlePorts;
                if (tokenToApply !== null) lastAppliedToken = tokenToApply;
                if (clearUnique) unique.clear();
                deps.startLogStream(idle, onLogLine);
                // Retire the old color once its connections drain (bounded).
                await deps.drainBackend(oldPorts, config.drainTimeoutMs, shutdownAbort.signal);
                await deps.stopColor(oldColor).catch(() => {});
                deps.log(`run-proxy: swap complete — now serving ${activeColor}`);
              }
            }
          }

          if (latestCreds !== null && !settled) {
            const nextPlan = planNextActions({
              creds: latestCreds,
              lastAppliedToken,
              now: deps.now(),
              config: planConfig,
              refresh: refreshState(),
            });
            armTimer(nextPlan.nudgeAt);
          }
        }
      } finally {
        restarting = false;
      }
    };

    const onSigintOnce = (): void => {
      // Guard the handler itself: a second Ctrl-C prints nothing and does nothing.
      if (sigintSeen || settled) return;
      sigintSeen = true;
      deps.log('run-proxy: SIGINT received, stopping (container left running)');
      shutdown(0);
    };

    const start = async (): Promise<void> => {
      const creds = deps.readCredentials(config.credentialsPath);
      if (creds === null) {
        fatal(`could not read credentials at ${config.credentialsPath}`);
        return;
      }

      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        fatal(`could not read allowlist at ${config.allowlistPath}`);
        return;
      }
      const allowlist = parseAllowlist(content);
      for (const warning of allowlist.warnings) deps.error(`run-proxy: ${warning}`);

      // Arm both watchers before the (slow) startup recreate: a change landing
      // mid-startup coalesces into one follow-up restart instead of being dropped.
      credentialsWatcher = deps.watch(config.credentialsPath, () => requestRestart('credentials'));
      allowlistWatcher = deps.watch(config.allowlistPath, () => requestRestart('allowlist'));
      deps.onSigint(onSigintOnce);

      restarting = true; // hold watcher events as pending until the startup bring-up is done
      try {
        try {
          applyAllowlist(allowlist);
        } catch (err) {
          fatal(`failed to build the proxy config: ${String(err)}`);
          return;
        }
        deps.writeSecret(creds.accessToken, config.secretPath);
        const ports = await deps.allocatePorts();
        try {
          await deps.bringUpColor('blue', ports);
        } catch {
          fatal('docker failed to start the proxy on startup');
          return;
        }
        if (settled) return;
        const result = await deps.waitColorReady(
          'blue',
          ports,
          config.readyTimeoutMs,
          shutdownAbort.signal,
        );
        if (settled) return;
        if (!result.ready) {
          fatal(
            result.reason === 'exited'
              ? 'proxy exited during startup — likely config issue, check the logs'
              : 'proxy did not become ready on startup',
          );
          return;
        }
        activeColor = 'blue';
        activePorts = ports;
        deps.setActiveBackend(ports);
        lastAppliedToken = creds.accessToken;
        lastSeenExpiresAt = creds.expiresAt;
        deps.startLogStream('blue', onLogLine);
      } finally {
        restarting = false;
      }

      const plan = planNextActions({
        creds,
        lastAppliedToken,
        now: deps.now(),
        config: planConfig,
        refresh: refreshState(),
      });
      armTimer(plan.nudgeAt);
      deps.log(
        `run-proxy: watching credentials and allowlist; proxy is serving the current token (${activeColor})`,
      );

      // Apply anything that landed during the startup recreate.
      if (pendingCredentials || pendingAllowlist) void drainRestarts();
    };

    void start();
  });
}
