import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { startGateway } from '../../../src/runProxy/gateway';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Echo server that prefixes every write with `tag:` so callers can tell targets apart. */
function startTaggedEcho(tag: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('data', (d) => sock.write(`${tag}:${d.toString()}`));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Send one payload on an already-open socket and resolve with the next chunk. */
function send(sock: net.Socket, payload: string): Promise<string> {
  return new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write(payload);
  });
}

/** Open a fresh connection, send once, resolve with the reply, then close. */
function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(payload));
    c.once('data', (d) => {
      resolve(d.toString());
      c.end();
    });
    c.on('error', reject);
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('startGateway', () => {
  it('routes new connections to the current target', async () => {
    const echo = await startTaggedEcho('one');
    const httpsListen = await freePort();
    const gw = await startGateway({
      listenAddresses: ['127.0.0.1'],
      httpsListenPort: httpsListen,
      httpListenPort: await freePort(),
      initialTarget: { httpsPort: echo.port, httpPort: 1 },
    });

    expect(await roundTrip(httpsListen, 'hi')).toBe('one:hi');

    await gw.close();
    await echo.close();
  });

  it('keeps existing connections on the old target after a flip; drain waits for them', async () => {
    const echo1 = await startTaggedEcho('one');
    const echo2 = await startTaggedEcho('two');
    const httpsListen = await freePort();
    const gw = await startGateway({
      listenAddresses: ['127.0.0.1'],
      httpsListenPort: httpsListen,
      httpListenPort: await freePort(),
      initialTarget: { httpsPort: echo1.port, httpPort: 1 },
    });

    // Long-lived connection bound to echo1.
    const sock = net.connect(httpsListen, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    expect(await send(sock, 'a')).toBe('one:a');

    gw.setTarget({ httpsPort: echo2.port, httpPort: 1 });

    // The pre-flip socket still reaches echo1; a new connection reaches echo2.
    expect(await send(sock, 'b')).toBe('one:b');
    expect(await roundTrip(httpsListen, 'c')).toBe('two:c');

    // Draining echo1 does not resolve while the old socket is open.
    let drained = false;
    const dp = gw
      .drain({ httpsPort: echo1.port, httpPort: 1 }, 2000, new AbortController().signal)
      .then(() => {
        drained = true;
      });
    await delay(200);
    expect(drained).toBe(false);

    sock.destroy();
    await dp;
    expect(drained).toBe(true);

    await gw.close();
    await echo1.close();
    await echo2.close();
  });

  it('force-closes remaining connections when drain times out', async () => {
    const echo = await startTaggedEcho('one');
    const httpsListen = await freePort();
    const gw = await startGateway({
      listenAddresses: ['127.0.0.1'],
      httpsListenPort: httpsListen,
      httpListenPort: await freePort(),
      initialTarget: { httpsPort: echo.port, httpPort: 1 },
    });

    const sock = net.connect(httpsListen, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    await send(sock, 'x');

    let closed = false;
    sock.on('close', () => {
      closed = true;
    });

    await gw.drain({ httpsPort: echo.port, httpPort: 1 }, 300, new AbortController().signal);
    expect(closed).toBe(true);

    await gw.close();
    await echo.close();
  });

  it('drain returns promptly on abort and does not force-close the lingering connection', async () => {
    const echo = await startTaggedEcho('one');
    const httpsListen = await freePort();
    const gw = await startGateway({
      listenAddresses: ['127.0.0.1'],
      httpsListenPort: httpsListen,
      httpListenPort: await freePort(),
      initialTarget: { httpsPort: echo.port, httpPort: 1 },
    });

    const sock = net.connect(httpsListen, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    await send(sock, 'x');

    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await gw.drain({ httpsPort: echo.port, httpPort: 1 }, 30_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(sock.destroyed).toBe(false); // teardown deferred to close()

    await gw.close();
    await echo.close();
  });
});
