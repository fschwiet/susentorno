import { combinePolicy, parseAllowListFile, parseAuthListFile, terminateTlsHosts, type Allowlist } from '../allowlist';
import { parseBlockListFile } from '../blockList';
import { parseLine } from './parseLine';
import { classify } from './classify';
import { formatOutput } from './formatOutput';
import { UniqueTracker } from './uniqueTracker';
import { CredentialChannel, type CredentialChannelConfig } from './credentialChannel';
import type { Color, ColorPorts } from './types';
import { otherColor } from './types';
import type { WaitResult } from './waitColorReady';
import type { McpServerConfig } from '../mcpServers';
import { resolveMcpAllowlistCollisions } from '../mcpServers';
import type { McpServerUpstream } from '../envoyConfig';
import { startMcpServers, type McpServerSpec, type McpSupervisorHandle } from './mcpSupervisor';

export interface RunHostingConfig {
  /** One entry per credential source (Claude, Codex). Each drives its own file watch, secret, and nudge timer. */
  channels: CredentialChannelConfig[];
  policyPaths: { allowList: string; authList: string; blockList: string };
  /** How long to wait for a freshly-started color's admin /ready before giving up. */
  readyTimeoutMs: number;
  /** How long to let the old color's connections finish before force-closing them. */
  drainTimeoutMs: number;
  /** Declared host-run MCP servers for this environment; defaults to none. */
  mcpServers?: McpServerConfig[];
  /** Fixed TCP-connect readiness timeout per MCP server. Defaults to 60s. */
  mcpReadyTimeoutMs?: number;
}

export interface RunHostingDeps {
  /** Raw allowlist file content, or null when unreadable. */
  readPolicyFile: (path: string) => string | null;
  /** Render and write envoy.yaml (upstream overrides are baked in by the caller). */
  buildConfig: (allowlist: Allowlist, mcpServers: McpServerUpstream[]) => void;
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
  onSigterm: (handler: () => void) => void;
  log: (message: string) => void;
  error: (message: string) => void;
  now: () => number;
  /** Allocate `count` distinct free loopback ports for the declared MCP servers. */
  allocateMcpPorts: (count: number) => Promise<number[]>;
  /** Spawn one MCP server's command; onLine receives its stdout/stderr, unprefixed. */
  spawnMcpServer: (
    spec: McpServerSpec,
    onLine: (line: string) => void,
  ) => { pid: number; onExit: (cb: (code: number | null, signal: string | null) => void) => void };
  /** TCP-connect readiness probe for one MCP server's port. */
  probeMcpReady: (port: number, timeoutMs: number) => Promise<boolean>;
  /** Kill an MCP server's whole process tree. */
  killProcessTree: (pid: number, signal: NodeJS.Signals) => Promise<void>;
}

/**
 * Long-running orchestrator. Owns the proxy end to end: builds envoy.yaml from the
 * allowlist, keeps every channel's SDS secret fresh, watches all files, restarts the
 * container on changes (serialized, coalescing bursts), and streams the tagged access
 * log inline (each host+handling once). Resolves with a process exit code: 0 on SIGINT
 * (container left running), 1 on any fatal error (including any channel exhausting its
 * refresh attempts).
 */
export function runHostingLoop(config: RunHostingConfig, deps: RunHostingDeps): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    let restarting = false;
    let pendingPolicy = false;
    const dirtyChannels = new Set<CredentialChannel>();
    let stopSignalSeen = false;
    let activeColor: Color = 'blue';
    let activePorts: ColorPorts | null = null;
    const unique = new UniqueTracker();
    const shutdownAbort = new AbortController();
    const watchers: { close: () => void }[] = [];

    const mcpServerConfigs = config.mcpServers ?? [];
    const mcpReadyTimeoutMs = config.mcpReadyTimeoutMs ?? 60_000;
    const mcpHostnames = mcpServerConfigs.map((s) => s.hostname);
    let mcpServersWithPorts: McpServerUpstream[] = [];
    let mcpSupervisorHandle: McpSupervisorHandle | null = null;

    /**
     * `settled` flips to true synchronously, before `beforeTeardown` (if given) runs —
     * not after it resolves. This matters for mcpFatal below: without it, a SIGINT
     * racing in during mcpFatal's async color-stopping could call shutdown(0) first
     * and "win" with a clean exit code, silently losing the fact that an MCP server
     * had failed. Reserving `settled` immediately closes that window.
     */
    const shutdown = (code: number, beforeTeardown?: () => Promise<void>): void => {
      if (settled) return;
      settled = true;
      shutdownAbort.abort();
      for (const channel of channels) channel.clearTimer();
      for (const watcher of watchers) watcher.close();
      const pre = beforeTeardown ? beforeTeardown() : Promise.resolve();
      void pre
        .then(() =>
          Promise.all([deps.stopLogStream(), mcpSupervisorHandle?.stopAll() ?? Promise.resolve()]),
        )
        .then(() => resolve(code));
    };

    const fatal = (message: string): void => {
      if (settled) return;
      deps.error(`run-hosting: ${message}`);
      shutdown(1);
    };

    /**
     * An MCP-triggered fatal additionally stops both Envoy colors before the normal
     * shutdown teardown runs: unlike every other fatal path, leaving the container
     * running would let every other destination keep working while only the failed
     * MCP hostname went dead — exactly the silent partial degradation this exists to
     * prevent. stopColor on a color that was never brought up (or already stopped) is
     * expected to no-op or fail harmlessly; Promise.allSettled tolerates either. Note
     * this does NOT cover the process-level uncaughtException/unhandledRejection
     * safety net installed in commands/runHosting.ts, which calls process.exit()
     * directly and — like every other resource this codebase owns (including the
     * Envoy container itself) — is not expected to run any cleanup on a genuine crash;
     * that safety net's job is only the spoken alert, not graceful teardown.
     */
    const mcpFatal = (message: string): void => {
      if (settled) return;
      deps.error(`run-hosting: ${message}`);
      shutdown(1, () =>
        Promise.allSettled([deps.stopColor('blue'), deps.stopColor('green')]).then(() => undefined),
      );
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
    const readParsedPolicy = (): Allowlist | null => {
      const contents = [
        deps.readPolicyFile(config.policyPaths.allowList),
        deps.readPolicyFile(config.policyPaths.authList),
        deps.readPolicyFile(config.policyPaths.blockList),
      ];
      const paths = [config.policyPaths.allowList, config.policyPaths.authList, config.policyPaths.blockList];
      const missing = contents.findIndex((content) => content === null);
      if (missing !== -1) {
        deps.error(`run-hosting: could not read policy at ${paths[missing]}, keeping previous config`);
        return null;
      }
      const allowlist = resolveMcpAllowlistCollisions(
        combinePolicy(parseAllowListFile(contents[0]!), parseAuthListFile(contents[1]!), parseBlockListFile(contents[2]!)),
        mcpServerConfigs,
      );
      for (const warning of allowlist.warnings) deps.error(`run-hosting: ${warning}`);
      return allowlist;
    };

    /** Reissue the leaf if the TLS-terminated hosts changed and rewrite envoy.yaml. */
    const applyPolicy = (allowlist: Allowlist): void => {
      deps.log(
        `run-hosting: ${deps.ensureLeaf([...terminateTlsHosts(allowlist), ...mcpHostnames])}`,
      );
      deps.buildConfig(allowlist, mcpServersWithPorts);
    };

    const requestRestart = (source: CredentialChannel | 'policy'): void => {
      if (settled) return;
      if (source === 'policy') pendingPolicy = true;
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
        while (!settled && (dirtyChannels.size > 0 || pendingPolicy)) {
          const policyDirty = pendingPolicy;
          const channelsThisPass = [...dirtyChannels];
          pendingPolicy = false;
          dirtyChannels.clear();

          let restartNeeded = false;
          let clearUnique = false;
          const reasons: string[] = [];

          if (policyDirty) {
            const allowlist = readParsedPolicy();
            if (allowlist !== null) {
              try {
                applyPolicy(allowlist);
              } catch (err) {
                fatal(`failed to rebuild the proxy config: ${String(err)}`);
                return;
              }
              restartNeeded = true;
              clearUnique = true; // wholesale reset, per design
              reasons.push('policy changed');
            }
          }

          const appliedChannels: CredentialChannel[] = [];
          const readableChannels: CredentialChannel[] = [];
          for (const channel of channelsThisPass) {
            const result = channel.prepareRestart();
            if (result.readable) readableChannels.push(channel);
            else
              deps.error(
                `run-hosting: skipped ${channel.name} credentials event (unreadable or partial write)`,
              );
            if (result.restartNeeded) {
              restartNeeded = true;
              appliedChannels.push(channel);
              reasons.push(`${channel.name} credentials changed`);
            }
          }

          if (restartNeeded && activePorts !== null) {
            deps.log(`run-hosting: restarting proxy — ${reasons.join(', ')}`);
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
                `run-hosting: could not start the new proxy (${idle}) — keeping the current proxy: ${String(err)}`,
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
                    ? `run-hosting: new proxy (${idle}) exited during startup — likely config issue, check the logs`
                    : `run-hosting: new proxy (${idle}) did not become ready — keeping the current proxy`,
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
                deps.log(`run-hosting: swap complete — now serving ${activeColor}`);
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

    const onStopSignal = (signalName: 'SIGINT' | 'SIGTERM'): void => {
      if (stopSignalSeen || settled) return;
      stopSignalSeen = true;
      deps.log(`run-hosting: ${signalName} received, stopping (container left running)`);
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

      const mcpPorts =
        mcpServerConfigs.length > 0 ? await deps.allocateMcpPorts(mcpServerConfigs.length) : [];
      mcpServersWithPorts = mcpServerConfigs.map((s, i) => ({
        hostname: s.hostname,
        port: mcpPorts[i],
      }));
      // {ip} is always 127.0.0.1: the spawned process itself must bind loopback only
      // (see the design spec) — only the Envoy cluster upstream uses host.docker.internal.
      const mcpSpecs: McpServerSpec[] = mcpServerConfigs.map((s, i) => ({
        name: s.name,
        hostname: s.hostname,
        port: mcpPorts[i],
        command: s.command
          .replaceAll('{ip}', '127.0.0.1')
          .replaceAll('{port}', String(mcpPorts[i])),
        cwd: s.cwd,
        env: s.env,
      }));

      const contents = [
        deps.readPolicyFile(config.policyPaths.allowList),
        deps.readPolicyFile(config.policyPaths.authList),
        deps.readPolicyFile(config.policyPaths.blockList),
      ];
      const paths = [config.policyPaths.allowList, config.policyPaths.authList, config.policyPaths.blockList];
      const missing = contents.findIndex((content) => content === null);
      if (missing !== -1) {
        fatal(`could not read policy at ${paths[missing]}`);
        return;
      }
      const allowlist = resolveMcpAllowlistCollisions(
        combinePolicy(parseAllowListFile(contents[0]!), parseAuthListFile(contents[1]!), parseBlockListFile(contents[2]!)),
        mcpServerConfigs,
      );
      for (const warning of allowlist.warnings) deps.error(`run-hosting: ${warning}`);

      // Arm all watchers before the (slow) startup recreate: a change landing
      // mid-startup coalesces into one follow-up restart instead of being dropped.
      for (const channel of channels) {
        watchers.push(deps.watch(channel.credentialsPath, () => requestRestart(channel)));
      }
      for (const path of paths) watchers.push(deps.watch(path, () => requestRestart('policy')));
      deps.onSigint(() => onStopSignal('SIGINT'));
      deps.onSigterm(() => onStopSignal('SIGTERM'));

      restarting = true; // hold watcher events as pending until the startup bring-up is done
      try {
        try {
          applyPolicy(allowlist);
        } catch (err) {
          fatal(`failed to build the proxy config: ${String(err)}`);
          return;
        }

        // Spawn MCP servers now that ports/hostnames are baked into envoy.yaml.
        // Readiness/exit supervision runs in the background for the rest of the
        // process; Envoy's own bring-up below proceeds without waiting on it.
        if (mcpSpecs.length > 0) {
          mcpSupervisorHandle = startMcpServers(mcpSpecs, {
            spawn: deps.spawnMcpServer,
            probeReady: deps.probeMcpReady,
            killProcessTree: deps.killProcessTree,
            onLine: (name, line) => deps.log(`[${name}] ${line}`),
            onReady: (name, elapsedMs) => deps.log(`[${name}] ready in ${elapsedMs}ms`),
            onFatal: (message) => mcpFatal(message),
            now: deps.now,
            readyTimeoutMs: mcpReadyTimeoutMs,
          });
        }

        // Secrets were already written by each channel's startupRead().
        const colorPorts = await deps.allocatePorts();
        // An MCP fatal can land during the allocatePorts() await above (it already
        // stopped both colors as part of its own teardown); without this check,
        // bringUpColor below would start blue right back up after that teardown.
        if (settled) return;
        try {
          await deps.bringUpColor('blue', colorPorts);
        } catch {
          fatal('docker failed to start the proxy on startup');
          return;
        }
        if (settled) return;
        const result = await deps.waitColorReady(
          'blue',
          colorPorts,
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
        activePorts = colorPorts;
        deps.setActiveBackend(colorPorts);
        for (const channel of channels) channel.commit();
        deps.startLogStream('blue', onLogLine);
      } finally {
        restarting = false;
      }

      for (const channel of channels) channel.armTimer();
      deps.log(
        `run-hosting: watching credentials and policy files; proxy is serving the current token (${activeColor})`,
      );

      // Apply anything that landed during the startup recreate.
      if (dirtyChannels.size > 0 || pendingPolicy) void drainRestarts();
    };

    void start();
  });
}
