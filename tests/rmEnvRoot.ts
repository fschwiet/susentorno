import { rmSync } from 'node:fs';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delete an environment root, riding out transient Windows file locks.
 *
 * The proxy-stack and guest suites rebuild `.configamatron` from scratch each run.
 * On Windows, whatever holds a handle inside the tree at delete time —
 * VS Code's C# Dev Kit build host (which auto-builds the copied dns-responder
 * .csproj), Defender, the Search Indexer, Docker Desktop's file sharing — makes
 * a plain delete fail with EPERM/EBUSY. Those holders release within a second or
 * two, so we retry with linear backoff (~19s worst case) until the tree is gone.
 *
 * Note: `rmSync`'s own `maxRetries`/`retryDelay` options are NOT used — the
 * synchronous rimraf does not actually back off on a sharing-violation EPERM
 * (verified empirically), so we drive the retry loop ourselves.
 */
export async function rmEnvRoot(envRoot: string): Promise<void> {
  const maxRetries = 12;
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(envRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= maxRetries || !RETRYABLE.has(code)) throw error;
      await sleep(250 * (attempt + 1));
    }
  }
}
