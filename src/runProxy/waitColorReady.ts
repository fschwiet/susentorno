import { request } from 'node:http';

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a color's OWN admin /ready until it answers 200 (returns true) or the
 * timeout elapses (returns false). Because each color has its own admin port,
 * a 200 here means THAT container is serving — unlike the in-place-recreate
 * case where the dying container answered /ready during the swap.
 */
export async function waitColorReady(
  adminPort: number,
  timeoutMs: number,
  sleepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await adminReadyOnce(adminPort)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(sleepMs);
  }
}
