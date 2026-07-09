import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export const DEFAULT_VMNET_ADAPTER = 'VMware Network Adapter VMnet1';

/**
 * IPv4 address of the VMware host-only adapter to forward from, or null if the
 * adapter is not present. `interfaces` is injectable for testing.
 */
export function resolveForwardListenAddress(
  adapterName: string = DEFAULT_VMNET_ADAPTER,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const addrs = interfaces[adapterName];
  if (!addrs) return null;
  for (const a of addrs) {
    if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

import net from 'node:net';

export interface ForwardRule {
  listenPort: number;
  connectPort: number;
}

export interface ForwarderOptions {
  listenAddress: string;
  connectHost?: string;
  rules: ForwardRule[];
}

export interface ForwarderHandle {
  close(): Promise<void>;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Start one TCP forwarder per rule: accept on `listenAddress:listenPort` and pipe
 * each connection to `connectHost:connectPort` (connectHost defaults to loopback).
 * Byte-transparent; serves HTTP, TLS passthrough, and TLS-terminate alike.
 */
export function startForwarder(opts: ForwarderOptions): Promise<ForwarderHandle> {
  const connectHost = opts.connectHost ?? '127.0.0.1';
  const servers: net.Server[] = [];

  const startOne = (rule: ForwardRule): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const server = net.createServer((client) => {
        const upstream = net.connect(rule.connectPort, connectHost);
        const teardown = (): void => {
          client.destroy();
          upstream.destroy();
        };
        upstream.on('error', teardown);
        client.on('error', teardown);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      server.once('error', reject);
      server.listen(rule.listenPort, opts.listenAddress, () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });

  return (async () => {
    try {
      for (const rule of opts.rules) {
        servers.push(await startOne(rule));
      }
    } catch (err) {
      await Promise.all(servers.map(closeServer));
      throw err;
    }
    return {
      close: async () => {
        await Promise.all(servers.map(closeServer));
      },
    };
  })();
}

export interface ForwarderPlanInput {
  noForward: boolean;
  forwardListen?: string;
  httpPort: number;
  httpsPort: number;
}

export type ForwarderPlan =
  | { kind: 'disabled' }
  | { kind: 'error'; message: string }
  | { kind: 'start'; listenAddress: string; rules: ForwardRule[] };

/**
 * Decide whether/how to start the forwarder from CLI options. Pure and testable;
 * `resolveAddress` is called only when discovery is needed.
 */
export function planForwarder(
  input: ForwarderPlanInput,
  resolveAddress: () => string | null,
): ForwarderPlan {
  if (input.noForward) return { kind: 'disabled' };
  const listenAddress = input.forwardListen ?? resolveAddress();
  if (!listenAddress) {
    return {
      kind: 'error',
      message:
        'could not find the VMware host-only adapter IP to forward from. ' +
        'Pass --forward-listen <ip>, or --no-forward to disable forwarding.',
    };
  }
  return {
    kind: 'start',
    listenAddress,
    rules: [
      { listenPort: input.httpPort, connectPort: input.httpPort },
      { listenPort: input.httpsPort, connectPort: input.httpsPort },
    ],
  };
}
