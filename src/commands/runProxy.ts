import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { readCredentials } from '../runProxy/readCredentials';
import { writeSecret } from '../runProxy/writeSecret';
import { recreateContainer } from '../runProxy/recreateContainer';
import { nudgeRefresh } from '../runProxy/nudgeRefresh';
import { watchCredentials } from '../runProxy/watchCredentials';
import { runProxyLoop, type RunProxyDeps } from '../runProxy/runProxyLoop';
import { requireEnvPathsOrExit } from '../envPaths';
import {
  planForwarder,
  resolveForwardListenAddress,
  startForwarder,
  type ForwarderHandle,
} from '../runProxy/forwarder';

interface RunProxyOptions {
  credentials: string;
  secret?: string;
  service: string;
  refreshWindow: string;
  retryInterval: string;
  maxAttempts: string;
  refresh: boolean;
  forward: boolean;
  forwardListen?: string;
  forwardPorts?: string;
}

export function registerRunProxy(program: Command): void {
  program
    .command('run-proxy')
    .description(
      'Own the Envoy proxy lifecycle: write the SDS secret, recreate the container so ' +
        'Envoy reads the current Claude token, then watch credentials.json and keep the ' +
        'token fresh. Foreground process; Ctrl-C to stop (leaves the container running).',
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
    .option('--service <name>', 'docker compose service to recreate', 'envoy')
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
    .action(async (options: RunProxyOptions) => {
      const paths = requireEnvPathsOrExit('run-proxy');
      if (!paths) return;
      if (!existsSync(paths.envoyConfig)) {
        console.error(
          `run-proxy: ${paths.envoyConfig} not found — run 'configamatron build-envoy-config' first`,
        );
        process.exitCode = 1;
        return;
      }
      if (!existsSync(paths.caCert)) {
        console.error(
          `run-proxy: ${paths.caCert} not found — run 'configamatron generate-ca' first`,
        );
        process.exitCode = 1;
        return;
      }
      // The generated Envoy config references leaf-cert.pem only when it terminates TLS.
      // If it does, the leaf must be present — a stale allowlist edit without a re-run of
      // generate-ca would otherwise fail deep inside Envoy startup.
      if (
        readFileSync(paths.envoyConfig, 'utf8').includes('leaf-cert.pem') &&
        !existsSync(paths.caLeafCert)
      ) {
        console.error(
          `run-proxy: ${paths.caLeafCert} not found — the Envoy config terminates TLS; ` +
            "run 'configamatron generate-ca' after updating the allowlist",
        );
        process.exitCode = 1;
        return;
      }
      const secretPath = options.secret ?? paths.sdsSecret;

      const deps: RunProxyDeps = {
        readCredentials,
        writeSecret,
        recreateContainer: (serviceName) => recreateContainer(serviceName, paths.proxy),
        nudgeRefresh,
        watch: watchCredentials,
        onSigint: (handler) => process.on('SIGINT', handler),
        log: (message) => console.log(message),
        error: (message) => console.error(message),
        now: () => Date.now(),
      };

      const [httpPort, httpsPort] = options.forwardPorts
        ? options.forwardPorts.split(',').map((p) => Number(p.trim()))
        : [Number(process.env.ENVOY_HTTP_PORT ?? 80), Number(process.env.ENVOY_HTTPS_PORT ?? 443)];

      let forwarder: ForwarderHandle | null = null;
      const plan = planForwarder(
        {
          noForward: !options.forward,
          forwardListen: options.forwardListen,
          httpPort,
          httpsPort,
        },
        () => resolveForwardListenAddress(),
      );
      if (plan.kind === 'error') {
        console.error(`run-proxy: ${plan.message}`);
        process.exitCode = 1;
        return;
      }
      if (plan.kind === 'start') {
        try {
          forwarder = await startForwarder({
            listenAddress: plan.listenAddress,
            rules: plan.rules,
          });
          console.log(
            `run-proxy: forwarding ${plan.listenAddress}:${httpPort}/${httpsPort} -> 127.0.0.1`,
          );
        } catch (err) {
          console.error(
            `run-proxy: failed to start forwarder on ${plan.listenAddress}: ${String(err)}`,
          );
          process.exitCode = 1;
          return;
        }
      }

      try {
        const exitCode = await runProxyLoop(
          {
            credentialsPath: options.credentials,
            secretPath,
            serviceName: options.service,
            refreshWindowMs: Number(options.refreshWindow) * 60_000,
            retryIntervalMs: Number(options.retryInterval) * 60_000,
            maxAttempts: Number(options.maxAttempts),
            refreshEnabled: options.refresh,
          },
          deps,
        );
        process.exitCode = exitCode;
      } finally {
        await forwarder?.close();
      }
    });
}
