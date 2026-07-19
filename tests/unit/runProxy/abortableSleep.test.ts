import { describe, it, expect } from 'vitest';
import { sleep } from '../../../src/runProxy/abortableSleep';

describe('sleep', () => {
  it('resolves after the delay when there is no signal', async () => {
    const start = Date.now();
    await sleep(40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await sleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('resolves promptly when the signal aborts mid-sleep', async () => {
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 20);
    await sleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
