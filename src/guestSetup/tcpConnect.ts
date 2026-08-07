import { Socket } from 'node:net';

export type TcpConnector = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/**
 * A raw socket connect/close, not a full SSH handshake — deliberately avoids
 * running real SSH during the reachability poll (see reachabilityWait.ts).
 * No dedicated unit test (thin production wrapper, same as createSshRemoteExec).
 */
export const realTcpConnect: TcpConnector = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
