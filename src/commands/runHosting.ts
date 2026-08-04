import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { readCredentials } from '../runHosting/readCredentials';
import { readCodexCredentials } from '../runHosting/readCodexCredentials';
import { writeSecret } from '../runHosting/writeSecret';
import { nudgeRefresh } from '../runHosting/nudgeRefresh';
import { nudgeCodexRefresh } from '../runHosting/nudgeCodexRefresh';
import { watchFile } from '../runHosting/watchFile';
import { runHostingLoop, type RunHostingDeps } from '../runHosting/runHostingLoop';
import type { CredentialChannelConfig } from '../runHosting/credentialChannel';
import { writeEnvoyConfig } from '../runHosting/buildConfig';
import { startLogStream, type LogStreamHandle } from '../runHosting/logStream';
import { ensureLeaf } from '../leaf';
import { requireEnvPathsOrExit } from '../envPaths';
import type { UpstreamOverride, InjectFault } from '../envoyConfig';
import { resolveForwardListenAddress, resolveInternalSwitchNetwork } from '../runHosting/forwarder';
import { startGateway, type GatewayHandle } from '../runHosting/gateway';
import { startDnsResponder } from '../runHosting/dnsResponder';
import { createServiceStack } from '../runHosting/serviceStack';
import { startDhcpServer } from '../runHosting/dhcpServer';
import { allocateColorPorts } from '../runHosting/allocateColorPorts';
import { bringUpColor, stopColor } from '../runHosting/colorContainer';
import { waitColorReady } from '../runHosting/waitColorReady';
import { isColorRunning } from '../runHosting/isColorRunning';
import type { Color, ColorPorts } from '../runHosting/types';
import {
  relaunchIfNeeded,
  createRelaunchDeps,
  relaunchFailedWithNoChild,
} from '../runHosting/relaunchViaDedicatedNode';
import {
  createRealAbnormalExitAlert,
  type AbnormalExitAlert,
} from '../runHosting/abnormalExitAlert';
import { readMcpServers } from '../mcpServers';
import { allocateMcpPorts } from '../runHosting/allocateMcpPorts';
import { spawnMcpServer, probeMcpReady } from '../runHosting/mcpProcess';
import { killProcessTree } from '../runHosting/killProcessTree';

interface RunHostingOptions {
  credentials: string;
  secret?: string;
  codexCredentials: string;
  codexSecret?: string;
  refreshWindow: string;
  retryInterval: string;
  maxAttempts: string;
  refresh: boolean;
  forward: boolean;
  forwardListen?: string;
  upstreamOverride: UpstreamOverride[];
  injectFault?: InjectFault;
  skipAllowList?: boolean;
}

function collectOverride(value: string, previous: UpstreamOverride[]): UpstreamOverride[] {
  const [sniHost, target] = value.split('=');
  return [...previous, { sniHost, target }];
}

/**
 * `uncaughtException`/`unhandledRejection` are the catch-all beneath every other guard: any
 * future failure path that doesn't set process.exitCode itself, or that throws where nothing
 * local catches it, still speaks the alert instead of failing silently.
 *
 * Registering either listener suppresses Node's default fatal-crash behavior (immediate
 * process termination) — without an explicit exit here, a process with open handles (docker
 * children, file watchers, the gateway's listening sockets) would announce failure and then
 * hang instead of actually exiting, which is strictly worse than today's unhandled behavior.
 * `alert.trigger()` fires its detached, unref'd spawn synchronously and returns immediately
 * (see `speakAlert` in `abnormalExitAlert.ts`), so it's safe to call `process.exit()` right
 * after it — the alert's own child process is unaffected by this process exiting.
 */
function installAbnormalExitHandlers(alert: AbnormalExitAlert): void {
  process.on('uncaughtException', (err) => {
    console.error(`run-hosting: uncaught exception: ${String(err)}`);
    alert.trigger();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`run-hosting: unhandled rejection: ${String(reason)}`);
    alert.trigger();
    process.exit(1);
  });
}

export function registerRunHosting(program: Command): void {
  program
    .command('run-hosting')
    .description(
      'Own the proxy stack end to end: build its configuration from the allow list, auth list, and block list, write the SDS ' +
        'secret, recreate the container, then watch the policy files and credentials.json — ' +
        'rebuilding the config, reissuing the leaf certificate, and restarting the proxy as ' +
        "they change — while streaming the proxy's tagged access log (each host+handling " +
        'once). Foreground process; Ctrl-C to stop (leaves the container running).',
    )
    .option(
      '--credentials <path>',
      'Claude credentials file to watch',
      join(homedir(), '.claude', '.credentials.json'),
    )
    .option(
      '--secret <path>',
      'SDS secret output path (default: .susentorno/proxy/secrets/sds-secret.yaml)',
    )
    .option(
      '--codex-credentials <path>',
      'Codex auth.json to watch',
      join(homedir(), '.codex', 'auth.json'),
    )
    .option(
      '--codex-secret <path>',
      'Codex SDS secret output path (default: .susentorno/proxy/secrets/codex-secret.yaml)',
    )
    .option('--refresh-window <minutes>', 'nudge this many minutes before expiry', '3')
    .option('--retry-interval <minutes>', 'wait this many minutes for a nudge to take', '2')
    .option('--max-attempts <n>', 'consecutive failed refreshes before exiting', '3')
    .option('--no-refresh', 'watch and propagate only; never nudge the CLI to refresh')
    .option('--no-forward', 'do not forward the Hyper-V Internal-switch interface to loopback')
    .option(
      '--forward-listen <ip>',
      'IP to forward from (default: the Hyper-V Internal-switch adapter IP)',
    )
    .option(
      '--upstream-override <sniHost=host:port>',
      'redirect a TLS-terminating cluster to a different upstream (test use only)',
      collectOverride,
      [] as UpstreamOverride[],
    )
    .option(
      '--inject-fault <crash-config|never-ready>',
      'render a deliberately broken envoy.yaml to exercise proxy robustness (test use only)',
    )
    .option('--skip-allow-list', 'do not enforce allow-list.txt; block-list.txt is still enforced')
    .action(async (options: RunHostingOptions) => {
      const alert = createRealAbnormalExitAlert();
      installAbnormalExitHandlers(alert);

      try {
        const relaunch = await relaunchIfNeeded(createRelaunchDeps(options.forward));
        if (relaunch.relaunched) {
          process.exitCode = relaunch.exitCode;
          if (relaunchFailedWithNoChild(relaunch)) alert.trigger();
          return;
        }
      } catch (err) {
        console.error(
          `run-hosting: failed to relaunch through the dedicated node.exe copy: ${String(err)}`,
        );
        process.exitCode = 1;
        alert.trigger();
        return;
      }

      try {
        const paths = requireEnvPathsOrExit('run-hosting');
        if (!paths) return;
        // run-hosting reissues the leaf itself but never the root: the root must
        // already exist (and be trusted in the guest) via generate-ca.
        if (!existsSync(paths.caCert) || !existsSync(paths.caKey)) {
          console.error(
            `run-hosting: proxy CA not found in ${paths.caDir} — run 'susentorno generate-ca' first`,
          );
          process.exitCode = 1;
          return;
        }
        const secretPath = options.secret ?? paths.sdsSecret;
        if (options.skipAllowList) {
          console.log('run-hosting: --skip-allow-list is set — hosts not on allow-list.txt will pass through and be logged as such');
        }

        let mcpServers;
        try {
          mcpServers = readMcpServers(paths.mcpServers);
        } catch (err) {
          console.error(`run-hosting: ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }

        let logHandle: LogStreamHandle | null = null;

        const httpPort = Number(process.env.ENVOY_HTTP_PORT ?? 80);
        const httpsPort = Number(process.env.ENVOY_HTTPS_PORT ?? 443);

        // The gateway always owns the public ports on loopback; when forwarding is
        // enabled it also listens on the Hyper-V Internal-switch adapter. Both point
        // at the active color's backend ports.
        const listenAddresses = ['127.0.0.1'];
        if (options.forward) {
          const forwardIp = options.forwardListen ?? resolveForwardListenAddress();
          if (!forwardIp) {
            console.error(
              'run-hosting: could not find the Hyper-V Internal-switch adapter IP to forward from. ' +
                'Pass --forward-listen <ip>, or --no-forward to disable forwarding.',
            );
            process.exitCode = 1;
            return;
          }
          listenAddresses.push(forwardIp);
        }

        const services = createServiceStack();
        let gateway: GatewayHandle;
        try {
          gateway = await services.add(() =>
            startGateway({ listenAddresses, httpsListenPort: httpsPort, httpListenPort: httpPort }),
          );
        } catch (err) {
          console.error(`run-hosting: failed to start the gateway forwarder: ${String(err)}`);
          process.exitCode = 1;
          return;
        }
        console.log(
          `run-hosting: gateway listening on ${listenAddresses.join(', ')} :${httpPort}/${httpsPort}`,
        );

        if (options.forward) {
          const dnsIp = listenAddresses[listenAddresses.length - 1];
          try {
            await services.add(() =>
              startDnsResponder({
                listenAddress: dnsIp,
                answerIp: dnsIp,
                onError: (message) => console.error(`run-hosting: ${message}`),
              }),
            );
          } catch (err) {
            console.error(
              `run-hosting: failed to bind DNS on ${dnsIp}:53 — ${String(err)}. Another process may hold that specific address; a wildcard 0.0.0.0:53 holder (e.g. the ICS service) is expected and does not conflict.`,
            );
            process.exitCode = 1;
            return;
          }
          console.log(`run-hosting: DNS responder listening on ${dnsIp}:53 (all A -> ${dnsIp})`);
          const network = resolveInternalSwitchNetwork();
          const netmask = network?.address === dnsIp ? network.netmask : '255.255.255.0';
          try {
            await services.add(() =>
              startDhcpServer({
                listenAddress: dnsIp,
                netmask,
                onWarn: (message) => console.warn(`run-hosting: ${message}`),
                onError: (message) => console.error(`run-hosting: ${message}`),
              }),
            );
          } catch (err) {
            console.error(
              `run-hosting: failed to bind DHCP on ${dnsIp}:67 — ${String(err)}. Guests on the Internal switch cannot get an address without this.`,
            );
            process.exitCode = 1;
            return;
          }
          console.log(
            `run-hosting: DHCP server listening on ${dnsIp}:67 (router and DNS -> ${dnsIp}, mask ${netmask})`,
          );
        }

        const deps: RunHostingDeps = {
          readPolicyFile: (path) => {
            try {
              return readFileSync(path, 'utf8');
            } catch {
              return null;
            }
          },
          buildConfig: (allowlist, mcpServersWithPorts) =>
            writeEnvoyConfig(
              allowlist,
              paths.envoyConfig,
              options.upstreamOverride,
              options.injectFault,
              mcpServersWithPorts,
              options.skipAllowList,
            ),
          ensureLeaf: (sans) =>
            ensureLeaf(
              paths,
              readFileSync(paths.caCert, 'utf8'),
              readFileSync(paths.caKey, 'utf8'),
              sans,
            ),
          allocatePorts: allocateColorPorts,
          bringUpColor: (color: Color, ports: ColorPorts) =>
            bringUpColor(color, ports, paths.proxy),
          waitColorReady: (
            color: Color,
            ports: ColorPorts,
            timeoutMs: number,
            signal: AbortSignal,
          ) =>
            waitColorReady(ports.adminPort, timeoutMs, signal, () =>
              isColorRunning(color, paths.proxy),
            ),
          setActiveBackend: (ports: ColorPorts) =>
            gateway.setTarget({ httpsPort: ports.httpsPort, httpPort: ports.httpPort }),
          drainBackend: (ports: ColorPorts, timeoutMs: number, signal: AbortSignal) =>
            gateway.drain(
              { httpsPort: ports.httpsPort, httpPort: ports.httpPort },
              timeoutMs,
              signal,
            ),
          stopColor: (color: Color) => stopColor(color, paths.proxy),
          watch: watchFile,
          startLogStream: (color: Color, onLine) => {
            logHandle = startLogStream(`envoy_${color}`, paths.proxy, onLine);
          },
          stopLogStream: async () => {
            const handle = logHandle;
            logHandle = null;
            await handle?.stop();
          },
          onSigint: (handler) => process.on('SIGINT', handler),
          onSigterm: (handler) => process.on('SIGTERM', handler),
          log: (message) => console.log(message),
          error: (message) => console.error(message),
          now: () => Date.now(),
          allocateMcpPorts,
          spawnMcpServer: (spec, onLine) =>
            spawnMcpServer(spec.command, { cwd: spec.cwd, env: spec.env }, onLine),
          probeMcpReady,
          killProcessTree,
        };

        const refreshWindowMs = Number(options.refreshWindow) * 60_000;
        const retryIntervalMs = Number(options.retryInterval) * 60_000;
        const maxAttempts = Number(options.maxAttempts);

        const claudeChannel: CredentialChannelConfig = {
          name: 'claude',
          credentialsPath: options.credentials,
          secretPath,
          readCredentials,
          writeSecret: (token, path) => writeSecret(token, path, 'susentorno_bearer_token'),
          nudgeRefresh,
          refreshWindowMs,
          retryIntervalMs,
          maxAttempts,
          refreshEnabled: options.refresh,
        };

        const codexChannel: CredentialChannelConfig = {
          name: 'codex',
          credentialsPath: options.codexCredentials,
          secretPath: options.codexSecret ?? paths.codexSecret,
          readCredentials: readCodexCredentials,
          writeSecret: (token, path) => writeSecret(token, path, 'codex_bearer_token'),
          nudgeRefresh: nudgeCodexRefresh,
          refreshWindowMs,
          retryIntervalMs,
          maxAttempts,
          refreshEnabled: options.refresh,
        };

        try {
          const exitCode = await runHostingLoop(
            {
              channels: [claudeChannel, codexChannel],
              policyPaths: { allowList: paths.allowList, authList: paths.authList, blockList: paths.blockList },
              readyTimeoutMs: 60_000,
              drainTimeoutMs: 30_000,
              mcpServers,
              mcpReadyTimeoutMs: 60_000,
            },
            deps,
          );
          process.exitCode = exitCode;
        } finally {
          await services.closeAll();
        }
      } finally {
        if ((process.exitCode ?? 0) !== 0) alert.trigger();
      }
    });
}
