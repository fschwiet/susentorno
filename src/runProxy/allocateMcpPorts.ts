import net from 'node:net';

function openEphemeral(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Allocate `count` distinct free loopback ports, one per declared MCP server. All
 * sockets are held open at once before any is released, so the OS cannot hand out the
 * same port twice — same pattern as allocateColorPorts.
 */
export async function allocateMcpPorts(count: number): Promise<number[]> {
  if (count === 0) return [];
  const servers = await Promise.all(Array.from({ length: count }, () => openEphemeral()));
  const ports = servers.map((s) => (s.address() as net.AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  return ports;
}
