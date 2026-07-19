/**
 * Sleep that also resolves — without throwing — the moment `signal` aborts, so a
 * poll loop built on it bails out immediately on shutdown instead of waiting out
 * the full delay. With no signal (or a signal that never aborts) it behaves like
 * a plain setTimeout.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
