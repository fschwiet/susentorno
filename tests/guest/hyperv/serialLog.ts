import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import net from 'node:net';
export interface SerialLogHandle {
  stop(): Promise<void>;
}
/** A best-effort diagnostic side channel that reconnects over guest reboots. */
export function startSerialLog(pipeName: string, filePath: string): SerialLogHandle {
  mkdirSync(dirname(filePath), { recursive: true });
  const output = createWriteStream(filePath, { flags: 'a' });
  let socket: net.Socket | undefined;
  let stopped = false;
  const attach = () => {
    if (stopped) return;
    socket = net.connect({ path: `\\\\.\\pipe\\${pipeName}` });
    socket.on('data', (data) => output.write(data));
    const retry = () => {
      socket = undefined;
      if (!stopped) setTimeout(attach, 500);
    };
    socket.on('error', retry);
    socket.on('close', retry);
  };
  attach();
  return {
    stop: () => {
      stopped = true;
      socket?.destroy();
      return new Promise((resolve) => output.end(resolve));
    },
  };
}
