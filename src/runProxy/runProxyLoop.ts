import { parseAllowlist, terminateTlsHosts, type Allowlist } from '../allowlist';
import { parseLine } from './parseLine';
import { classify } from './classify';
import { formatOutput } from './formatOutput';
import { UniqueTracker } from './uniqueTracker';
import { CredentialChannel, type CredentialChannelConfig } from './credentialChannel';
import type { Color, ColorPorts } from './types';
import { otherColor } from './types';
import type { WaitResult } from './waitColorReady';

export interface RunProxyConfig {
  /** One entry per credential source (Claude, Codex). Each drives its own file watch, secret, and nudge timer. */
  channels: CredentialChannelConfig[];
  allowlistPath: string;
  /** How long to wait for a freshly-started color's admin /ready before giving up. */
  readyTimeoutMs: number;
  /** How long to let the old color's connections finish before force-closing them. */
  drainTimeoutMs: number;
}

export interface RunProxyDeps {
  /** Raw allowlist file content, or null when unreadable. */
  readAllowlist: (path: string) => string | null;
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
  /** File watcher; used for each channel's credentials file and the allowlist. */
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
 * Long-running orchestrator. Owns the proxy end to end: builds envoy.yaml from the
 * allowlist, keeps every channel's SDS secret fresh, watches all files, restarts the
 * container on changes (serialized, coalescing bursts), and streams the tagged access
 * log inline (each host+handling once). Resolves with a process exit code: 0 on SIGINT
 * (container left running), 1 on any fatal error (including any channel exhausting its
 * refresh attempts).
 */
export function runProxyLoop(config: RunProxyConfig, deps: RunProxyDeps): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    let restarting = false;
    let pendingAllowlist = false;
    const dirtyChannels = new Set<CredentialChannel>();
    let sigintSeen = false;
    let activeColor: Color = 'blue';
    let activePorts: ColorPorts | null = null;
    const unique = new UniqueTracker();
    const shutdownAbort = new AbortController();
    const watchers: { close: () => void }[] = [];

    /**
     * Tear down every long-lived handle, then resolve. `settled` flips synchronously so
     * no callback can act after shutdown begins; the log child is stopped asynchronously
     * before resolving so it cannot outlive us.
     */
    const shutdown = (code: number): void => {
      if (settled) return;
      settled = true;
      shutdownAbort.abort();
      for (const channel of channels) channel.clearTimer();
      for (const watcher of watchers) watcher.close();
      void deps.stopLogStream().then(() => resolve(code));
    };

    const fatal = (message: string): void => {
      if (settled) return;
      deps.error(`run-proxy: ${message}`);
      shutdown(1);
    };

    // Built after fatal so onExhausted can reference it; used only inside async callbacks
    // that run well after this synchronous setup completes.
    const channels = config.channels.map(
      (channelConfig) =>
        new CredentialChannel(channelConfig, {
          now: deps.now,
          onExhausted: (message) => fatal(message),
          isSettled: () => settled,
        }),
    );

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

    /** Reissue the leaf if the TLS-terminated hosts changed and rewrite envoy.yaml. */
    const applyAllowlist = (allowlist: Allowlist): void => {
      deps.log(`run-proxy: ${deps.ensureLeaf(terminateTlsHosts(allowlist))}`);
      deps.buildConfig(allowlist);
    };

    const requestRestart = (source: CredentialChannel | 'allowlist'): void => {
      if (settled) return;
      if (source === 'allowlist') pendingAllowlist = true;
      else dirtyChannels.add(source);
      if (!restarting) void drainRestarts();
    };

    /**
     * Serialized restart pipeline: at most one force-recreate runs at a time. Events
     * landing mid-restart only set pending flags/dirty entries; the while loop collapses
     * any burst into a single follow-up restart that re-reads every dirty source fresh.
     */
    const drainRestarts = async (): Promise<void> => {
      restarting = true;
      try {
        while (!settled && (dirtyChannels.size > 0 || pendingAllowlist)) {
          const allowlistDirty = pendingAllowlist;
          const channelsThisPass = [...dirtyChannels];
          pendingAllowlist = false;
          dirtyChannels.clear();

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

          const appliedChannels: CredentialChannel[] = [];
          const readableChannels: CredentialChannel[] = [];
          for (const channel of channelsThisPass) {
            const result = channel.prepareRestart();
            if (result.readable) readableChannels.push(channel);
            else
              deps.error(
                `run-proxy: skipped ${channel.name} credentials event (unreadable or partial write)`,
              );
            if (result.restartNeeded) {
              restartNeeded = true;
              appliedChannels.push(channel);
              reasons.push(`${channel.name} credentials changed`);
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
                for (const channel of appliedChannels) channel.commit();
                if (clearUnique) unique.clear();
                deps.startLogStream(idle, onLogLine);
                // Retire the old color once its connections drain (bounded).
                await deps.drainBackend(oldPorts, config.drainTimeoutMs, shutdownAbort.signal);
                await deps.stopColor(oldColor).catch(() => {});
                deps.log(`run-proxy: swap complete — now serving ${activeColor}`);
              }
            }
          }

          // Re-arm the nudge timer for each channel that produced a fresh read this pass.
          if (!settled) for (const channel of readableChannels) channel.armTimer();
        }
      } finally {
        restarting = false;
      }
    };

    const onSigintOnce = (): void => {
      if (sigintSeen || settled) return;
      sigintSeen = true;
      deps.log('run-proxy: SIGINT received, stopping (container left running)');
      shutdown(0);
    };

    const start = async (): Promise<void> => {
      // Read every channel up front (each also writes its secret + stages its token).
      // Any unreadable credential is fatal on startup, same as the old single source.
      for (const channel of channels) {
        const creds = channel.startupRead();
        if (creds === null) {
          fatal(`could not read ${channel.name} credentials at ${channel.credentialsPath}`);
          return;
        }
      }

      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        fatal(`could not read allowlist at ${config.allowlistPath}`);
        return;
      }
      const allowlist = parseAllowlist(content);
      for (const warning of allowlist.warnings) deps.error(`run-proxy: ${warning}`);

      // Arm all watchers before the (slow) startup recreate: a change landing
      // mid-startup coalesces into one follow-up restart instead of being dropped.
      for (const channel of channels) {
        watchers.push(deps.watch(channel.credentialsPath, () => requestRestart(channel)));
      }
      watchers.push(deps.watch(config.allowlistPath, () => requestRestart('allowlist')));
      deps.onSigint(onSigintOnce);

      restarting = true; // hold watcher events as pending until the startup bring-up is done
      try {
        try {
          applyAllowlist(allowlist);
        } catch (err) {
          fatal(`failed to build the proxy config: ${String(err)}`);
          return;
        }
        // Secrets were already written by each channel's startupRead().
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
        for (const channel of channels) channel.commit();
        deps.startLogStream('blue', onLogLine);
      } finally {
        restarting = false;
      }

      for (const channel of channels) channel.armTimer();
      deps.log(
        `run-proxy: watching credentials and allowlist; proxy is serving the current token (${activeColor})`,
      );

      // Apply anything that landed during the startup recreate.
      if (dirtyChannels.size > 0 || pendingAllowlist) void drainRestarts();
    };

    void start();
  });
}
