import { request } from 'node:http';
import { sleep } from './abortableSleep';

/** One probe of a color's admin /ready; true iff it answers HTTP 200. */
export function adminReadyOnce(adminPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: adminPort, path: '/ready', timeout: 1000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Poll a color's OWN admin /ready until it answers 200 (returns true) or the
 * timeout elapses (returns false). The signal short-circuits the wait: when it
 * aborts, the next check returns false immediately and the abortable sleep
 * resolves at once, so a Ctrl+C during startup is never blocked for the full
 * timeout.
 */
export async function waitColorReady(
  adminPort: number,
  timeoutMs: number,
  signal: AbortSignal,
  sleepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await adminReadyOnce(adminPort)) return true;
    if (signal.aborted) return false;
    if (Date.now() >= deadline) return false;
    await sleep(sleepMs, signal);
  }
}
