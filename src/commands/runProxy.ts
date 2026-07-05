import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { readCredentials } from '../runProxy/readCredentials';
import { writeSecret } from '../runProxy/writeSecret';
import { recreateContainer } from '../runProxy/recreateContainer';
import { nudgeRefresh } from '../runProxy/nudgeRefresh';
import { watchCredentials } from '../runProxy/watchCredentials';
import { runProxyLoop, type RunProxyDeps } from '../runProxy/runProxyLoop';

interface RunProxyOptions {
  credentials: string;
  secret: string;
  service: string;
  refreshWindow: string;
  retryInterval: string;
  maxAttempts: string;
  refresh: boolean;
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
    .option('--secret <path>', 'SDS secret output path', 'envoy/secrets/sds-secret.yaml')
    .option('--service <name>', 'docker compose service to recreate', 'envoy')
    .option('--refresh-window <minutes>', 'nudge this many minutes before expiry', '3')
    .option('--retry-interval <minutes>', 'wait this many minutes for a nudge to take', '2')
    .option('--max-attempts <n>', 'consecutive failed refreshes before exiting', '3')
    .option('--no-refresh', 'watch and propagate only; never nudge the CLI to refresh')
    .action(async (options: RunProxyOptions) => {
      const deps: RunProxyDeps = {
        readCredentials,
        writeSecret,
        recreateContainer,
        nudgeRefresh,
        watch: watchCredentials,
        onSigint: (handler) => process.on('SIGINT', handler),
        log: (message) => console.log(message),
        error: (message) => console.error(message),
        now: () => Date.now(),
      };

      const exitCode = await runProxyLoop(
        {
          credentialsPath: options.credentials,
          secretPath: options.secret,
          serviceName: options.service,
          refreshWindowMs: Number(options.refreshWindow) * 60_000,
          retryIntervalMs: Number(options.retryInterval) * 60_000,
          maxAttempts: Number(options.maxAttempts),
          refreshEnabled: options.refresh,
        },
        deps,
      );

      process.exitCode = exitCode;
    });
}
