import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { waitColorReady } from '../../../src/runProxy/waitColorReady';

let server: Server | undefined;

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

describe('waitColorReady', () => {
  it('resolves true once /ready returns 200 (after a few 503s)', async () => {
    const port = await listen((hits) => (hits >= 3 ? 200 : 503));
    expect(await waitColorReady(port, 5000, 20)).toBe(true);
  });

  it('resolves false when readiness never arrives before the timeout', async () => {
    const port = await listen(() => 503);
    expect(await waitColorReady(port, 300, 20)).toBe(false);
  });
});
