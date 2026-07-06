import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { execa } from 'execa';
import { requireEnvPathsOrExit } from '../envPaths';
import { parseLine } from '../proxyLogs/parseLine';
import { classify } from '../proxyLogs/classify';
import { keepEntry } from '../proxyLogs/entryFilter';
import { Reducer, type ReduceMode } from '../proxyLogs/reducer';
import { formatOutput } from '../proxyLogs/formatOutput';
import { killProcessTree } from '../proxyLogs/killProcessTree';

interface ProxyLogsOptions {
  service: string;
  follow: boolean;
  blocked: boolean;
  unique: boolean;
  debounce?: string;
}

export function registerProxyLogs(program: Command): void {
  program
    .command('proxy-logs')
    .description(
      "Stream the proxy's tagged access log — how each host was handled " +
        '(ALLOW CRED / ALLOW PASS / ALLOW HTTP / BLOCK TLS / BLOCK HTTP). ' +
        'Foreground process; Ctrl-C to stop.',
    )
    .option('--service <name>', 'docker compose service to read logs from', 'envoy')
    .option('--no-follow', 'print recent history and exit instead of streaming')
    .option('--blocked', 'show only BLOCK lines')
    .option('--unique', 'show each host/handling once for the session')
    .option('--debounce <seconds>', 'collapse repeats of a host/handling within N seconds')
    .action(async (options: ProxyLogsOptions) => {
      const paths = requireEnvPathsOrExit('proxy-logs');
      if (!paths) return;

      if (options.unique && options.debounce !== undefined) {
        console.error('proxy-logs: --unique and --debounce are mutually exclusive');
        process.exitCode = 1;
        return;
      }

      let mode: ReduceMode;
      if (options.unique) {
        mode = { kind: 'unique' };
      } else if (options.debounce !== undefined) {
        const seconds = Number(options.debounce);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          console.error('proxy-logs: --debounce requires a positive number of seconds');
          process.exitCode = 1;
          return;
        }
        mode = { kind: 'debounce', windowMs: seconds * 1000 };
      } else {
        mode = { kind: 'all' };
      }

      const reducer = new Reducer(mode);
      const args = ['compose', 'logs', ...(options.follow ? ['--follow'] : []), options.service];
      const child = execa('docker', args, {
        cwd: paths.proxy,
        buffer: false,
        detached: process.platform !== 'win32',
      });

      const onSigint = (): void => {
        if (child.pid === undefined) {
          child.kill('SIGINT');
          return;
        }
        void killProcessTree(child.pid, 'SIGINT');
      };
      process.on('SIGINT', onSigint);

      if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        rl.on('line', (raw) => {
          const access = parseLine(raw);
          if (!access) return;
          const entry = classify(access);
          if (!keepEntry(entry, options.blocked)) return;
          for (const out of reducer.push(entry)) {
            console.log(formatOutput(out));
          }
        });
      }

      try {
        await child;
      } catch {
        // Expected when the user Ctrl-C's (we kill the child) or docker exits non-zero.
      } finally {
        process.off('SIGINT', onSigint);
      }
    });
}
