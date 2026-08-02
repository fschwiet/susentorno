import net from 'node:net';
import type { ColorPorts } from './types';

/** Open an ephemeral loopback server and resolve with it (still listening). */
function openEphemeral(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/**
 * Allocate three distinct free loopback ports. All three sockets are held open
 * at once before any is read, so the OS cannot hand out the same port twice.
 * There is an unavoidable TOCTOU gap between closing here and Docker publishing;
 * it is small and standard for ephemeral-port handoff.
 */
export async function allocateColorPorts(): Promise<ColorPorts> {
  const servers = await Promise.all([openEphemeral(), openEphemeral(), openEphemeral()]);
  const [httpsPort, httpPort, adminPort] = servers.map(
    (s) => (s.address() as net.AddressInfo).port,
  );
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return { httpsPort, httpPort, adminPort };
}
