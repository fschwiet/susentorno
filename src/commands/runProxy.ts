import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { readCredentials } from '../runProxy/readCredentials';
import { writeSecret } from '../runProxy/writeSecret';
import { nudgeRefresh } from '../runProxy/nudgeRefresh';
import { watchFile } from '../runProxy/watchFile';
import { runProxyLoop, type RunProxyDeps } from '../runProxy/runProxyLoop';
import { writeEnvoyConfig } from '../runProxy/buildConfig';
import { startLogStream, type LogStreamHandle } from '../runProxy/logStream';
import { ensureLeaf } from '../leaf';
import { requireEnvPathsOrExit } from '../envPaths';
import type { UpstreamOverride } from '../envoyConfig';
import { resolveForwardListenAddress } from '../runProxy/forwarder';
import { startGateway, type GatewayHandle } from '../runProxy/gateway';
import { allocateColorPorts } from '../runProxy/allocateColorPorts';
import { bringUpColor, stopColor } from '../runProxy/colorContainer';
import { waitColorReady } from '../runProxy/waitColorReady';
import type { Color, ColorPorts } from '../runProxy/types';

interface RunProxyOptions {
  credentials: string;
  secret?: string;
  refreshWindow: string;
  retryInterval: string;
  maxAttempts: string;
  refresh: boolean;
  forward: boolean;
  forwardListen?: string;
  forwardPorts?: string;
  upstreamOverride: UpstreamOverride[];
}

function collectOverride(value: string, previous: UpstreamOverride[]): UpstreamOverride[] {
  const [sniHost, target] = value.split('=');
  return [...previous, { sniHost, target }];
}

export function registerRunProxy(program: Command): void {
  program
    .command('run-proxy')
    .description(
      'Own the Envoy proxy end to end: build envoy.yaml from the allowlist, write the SDS ' +
        'secret, recreate the container, then watch allowlist.txt and credentials.json — ' +
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
      'SDS secret output path (default: .configamatron/proxy/secrets/sds-secret.yaml)',
    )
    .option('--refresh-window <minutes>', 'nudge this many minutes before expiry', '3')
    .option('--retry-interval <minutes>', 'wait this many minutes for a nudge to take', '2')
    .option('--max-attempts <n>', 'consecutive failed refreshes before exiting', '3')
    .option('--no-refresh', 'watch and propagate only; never nudge the CLI to refresh')
    .option('--no-forward', 'do not forward the VMware host-only interface to loopback')
    .option(
      '--forward-listen <ip>',
      'IP to forward from (default: the VMware host-only adapter IP)',
    )
    .option(
      '--forward-ports <http,https>',
      'ports to forward (default: ENVOY_HTTP_PORT,ENVOY_HTTPS_PORT or 80,443)',
    )
    .option(
      '--upstream-override <sniHost=host:port>',
      'redirect a terminate cluster to a different upstream (test use only)',
      collectOverride,
      [] as UpstreamOverride[],
    )
    .action(async (options: RunProxyOptions) => {
      const paths = requireEnvPathsOrExit('run-proxy');
      if (!paths) return;
      // run-proxy reissues the leaf itself but never the root: the root must
      // already exist (and be trusted in the guest) via generate-ca.
      if (!existsSync(paths.caCert) || !existsSync(paths.caKey)) {
        console.error(
          `run-proxy: proxy CA not found in ${paths.caDir} — run 'configamatron generate-ca' first`,
        );
        process.exitCode = 1;
        return;
      }
      const secretPath = options.secret ?? paths.sdsSecret;

      let logHandle: LogStreamHandle | null = null;

      const [httpPort, httpsPort] = options.forwardPorts
        ? options.forwardPorts.split(',').map((p) => Number(p.trim()))
        : [Number(process.env.ENVOY_HTTP_PORT ?? 80), Number(process.env.ENVOY_HTTPS_PORT ?? 443)];

      // The gateway always owns the public ports on loopback; when forwarding is
      // enabled it also listens on the VMware host-only adapter. Both point at the
      // active color's backend ports.
      const listenAddresses = ['127.0.0.1'];
      if (options.forward) {
        const vmnet = options.forwardListen ?? resolveForwardListenAddress();
        if (!vmnet) {
          console.error(
            'run-proxy: could not find the VMware host-only adapter IP to forward from. ' +
              'Pass --forward-listen <ip>, or --no-forward to disable forwarding.',
          );
          process.exitCode = 1;
          return;
        }
        listenAddresses.push(vmnet);
      }

      let gateway: GatewayHandle;
      try {
        gateway = await startGateway({
          listenAddresses,
          httpsListenPort: httpsPort,
          httpListenPort: httpPort,
        });
      } catch (err) {
        console.error(`run-proxy: failed to start the gateway forwarder: ${String(err)}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `run-proxy: gateway listening on ${listenAddresses.join(', ')} :${httpPort}/${httpsPort}`,
      );

      const deps: RunProxyDeps = {
        readCredentials,
        readAllowlist: (path) => {
          try {
            return readFileSync(path, 'utf8');
          } catch {
            return null;
          }
        },
        writeSecret,
        buildConfig: (allowlist) =>
          writeEnvoyConfig(allowlist, paths.envoyConfig, options.upstreamOverride),
        ensureLeaf: (sans) =>
          ensureLeaf(
            paths,
            readFileSync(paths.caCert, 'utf8'),
            readFileSync(paths.caKey, 'utf8'),
            sans,
          ),
        allocatePorts: allocateColorPorts,
        bringUpColor: (color: Color, ports: ColorPorts) => bringUpColor(color, ports, paths.proxy),
        waitColorReady: (ports: ColorPorts, timeoutMs: number) =>
          waitColorReady(ports.adminPort, timeoutMs),
        setActiveBackend: (ports: ColorPorts) =>
          gateway.setTarget({ httpsPort: ports.httpsPort, httpPort: ports.httpPort }),
        drainBackend: (ports: ColorPorts, timeoutMs: number) =>
          gateway.drain({ httpsPort: ports.httpsPort, httpPort: ports.httpPort }, timeoutMs),
        stopColor: (color: Color) => stopColor(color, paths.proxy),
        nudgeRefresh,
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
        log: (message) => console.log(message),
        error: (message) => console.error(message),
        now: () => Date.now(),
      };

      try {
        const exitCode = await runProxyLoop(
          {
            credentialsPath: options.credentials,
            allowlistPath: paths.allowlist,
            secretPath,
            readyTimeoutMs: 60_000,
            drainTimeoutMs: 30_000,
            refreshWindowMs: Number(options.refreshWindow) * 60_000,
            retryIntervalMs: Number(options.retryInterval) * 60_000,
            maxAttempts: Number(options.maxAttempts),
            refreshEnabled: options.refresh,
          },
          deps,
        );
        process.exitCode = exitCode;
      } finally {
        await gateway.close();
      }
    });
}
