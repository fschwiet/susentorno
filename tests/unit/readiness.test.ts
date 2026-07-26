import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { waitColorReady } from '../../src/runProxy/waitColorReady';

let server: Server | undefined;
const alive = async (): Promise<boolean> => true;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function listen(handler: (n: number) => number): Promise<number> {
  let hits = 0;
  server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = handler(hits);
    res.end();
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as { port: number }).port);
    });
  });
}

describe('proxy stack readiness polling', () => {
  it('resolves ready once /ready returns 200 (after a few 503s)', async () => {
    const port = await listen((hits) => (hits >= 3 ? 200 : 503));
    const ac = new AbortController();
    expect(await waitColorReady(port, 5000, ac.signal, alive, 20)).toEqual({ ready: true });
  });

  it('resolves timeout when readiness never arrives (container stays alive)', async () => {
    const port = await listen(() => 503);
    const ac = new AbortController();
    expect(await waitColorReady(port, 300, ac.signal, alive, 20)).toEqual({
      ready: false,
      reason: 'timeout',
    });
  });

  it('resolves timeout promptly when the signal is already aborted', async () => {
    const port = await listen(() => 503);
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    expect(await waitColorReady(port, 10_000, ac.signal, alive, 20)).toEqual({
      ready: false,
      reason: 'timeout',
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('resolves exited promptly when the container is not running', async () => {
    const port = await listen(() => 503);
    const ac = new AbortController();
    const dead = async (): Promise<boolean> => false;
    const start = Date.now();
    expect(await waitColorReady(port, 10_000, ac.signal, dead, 20)).toEqual({
      ready: false,
      reason: 'exited',
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
