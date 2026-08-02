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

export type WaitResult = { ready: true } | { ready: false; reason: 'exited' | 'timeout' };

/**
 * Poll a color's OWN admin /ready until it answers 200 (`{ ready: true }`), the
 * container exits (`reason: 'exited'` — reported fast, no need to wait out the
 * timeout), the signal aborts, or the deadline passes (`reason: 'timeout'`).
 * `isAlive` is injected so this stays unit-testable without docker.
 */
export async function waitColorReady(
  adminPort: number,
  timeoutMs: number,
  signal: AbortSignal,
  isAlive: () => Promise<boolean>,
  sleepMs = 250,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await adminReadyOnce(adminPort)) return { ready: true };
    if (signal.aborted) return { ready: false, reason: 'timeout' };
    if (!(await isAlive())) return { ready: false, reason: 'exited' };
    if (Date.now() >= deadline) return { ready: false, reason: 'timeout' };
    await sleep(sleepMs, signal);
  }
}
