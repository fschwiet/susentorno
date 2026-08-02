import { createInterface } from 'node:readline';
import { execa } from 'execa';
import { killProcessTree } from './killProcessTree';

export interface LogStreamHandle {
  stop: () => Promise<void>;
}

/**
 * Follow the proxy container's log via `docker compose logs --follow` and feed
 * every raw line to onLine. run-hosting starts a fresh follow right after each
 * force-recreate — a follow attached to the previous container dies with it —
 * so no --tail/--since handling is needed: a fresh container's history is
 * empty and the follow sees every line from its birth.
 */
export function startLogStream(
  serviceName: string,
  composeDir: string,
  onLine: (raw: string) => void,
): LogStreamHandle {
  const child = execa('docker', ['compose', 'logs', '--follow', serviceName], {
    cwd: composeDir,
    buffer: false,
    detached: process.platform !== 'win32',
  });

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on('line', onLine);
  }

  // Swallow the rejection produced by killing the child (or docker exiting
  // non-zero); stop() awaits this so the pipe is fully closed before returning.
  const finished = child.catch(() => {});

  return {
    stop: async () => {
      if (child.pid !== undefined) {
        await killProcessTree(child.pid, 'SIGINT');
      } else {
        child.kill('SIGINT');
      }
      await finished;
    },
  };
}
