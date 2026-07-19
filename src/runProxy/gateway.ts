import net from 'node:net';
import { sleep } from './abortableSleep';

export interface GatewayTarget {
  httpsPort: number;
  httpPort: number;
}

export interface GatewayOptions {
  /** Addresses to listen on, e.g. ['127.0.0.1'] or ['127.0.0.1', '192.168.241.1']. */
  listenAddresses: string[];
  httpsListenPort: number;
  httpListenPort: number;
  /** Host the active color is published on; defaults to loopback. */
  connectHost?: string;
  /** Target to route to before the first setTarget; null drops connections. */
  initialTarget?: GatewayTarget | null;
}

export interface GatewayHandle {
  setTarget(target: GatewayTarget): void;
  /** Resolve once no connections remain on `target`'s ports, or force-close at timeout. On abort, stop waiting and return (teardown is left to close()). */
  drain(target: GatewayTarget, timeoutMs: number, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

interface Conn {
  client: net.Socket;
  upstream: net.Socket;
  connectPort: number;
}

/**
 * The stable front door. Always listens on the public ports and pipes each
 * connection to whichever color is currently active. A flip (setTarget) only
 * redirects NEW connections; connections already piped to the old color keep
 * flowing until they close or are force-closed by drain — that overlap IS the
 * zero-downtime property.
 */
export function startGateway(opts: GatewayOptions): Promise<GatewayHandle> {
  const connectHost = opts.connectHost ?? '127.0.0.1';
  let target: GatewayTarget | null = opts.initialTarget ?? null;
  const conns = new Set<Conn>();
  const servers: net.Server[] = [];

  const onClient = (client: net.Socket, isHttps: boolean): void => {
    if (!target) {
      client.destroy();
      return;
    }
    const connectPort = isHttps ? target.httpsPort : target.httpPort;
    const upstream = net.connect(connectPort, connectHost);
    const conn: Conn = { client, upstream, connectPort };
    conns.add(conn);
    const teardown = (): void => {
      conns.delete(conn);
      client.destroy();
      upstream.destroy();
    };
    upstream.on('error', teardown);
    client.on('error', teardown);
    client.on('close', teardown);
    upstream.on('close', teardown);
    client.pipe(upstream);
    upstream.pipe(client);
  };

  const startOne = (address: string, port: number, isHttps: boolean): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const server = net.createServer((client) => onClient(client, isHttps));
      server.once('error', reject);
      server.listen(port, address, () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });

  const onTarget = (t: GatewayTarget): Conn[] =>
    [...conns].filter((c) => c.connectPort === t.httpsPort || c.connectPort === t.httpPort);

  return (async () => {
    try {
      for (const address of opts.listenAddresses) {
        servers.push(await startOne(address, opts.httpsListenPort, true));
        servers.push(await startOne(address, opts.httpListenPort, false));
      }
    } catch (err) {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      throw err;
    }

    return {
      setTarget: (t: GatewayTarget): void => {
        target = t;
      },
      drain: async (t: GatewayTarget, timeoutMs: number, signal: AbortSignal): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (onTarget(t).length > 0 && Date.now() < deadline) {
          if (signal.aborted) return; // stop waiting; close() will destroy what remains
          await sleep(100, signal);
        }
        if (signal.aborted) return;
        await Promise.all(
          onTarget(t).map(
            (c) =>
              new Promise<void>((resolve) => {
                c.client.once('close', () => resolve());
                conns.delete(c);
                c.client.destroy();
                c.upstream.destroy();
              }),
          ),
        );
      },
      close: async (): Promise<void> => {
        for (const c of [...conns]) {
          c.client.destroy();
          c.upstream.destroy();
        }
        conns.clear();
        await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      },
    };
  })();
}
