import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { startDhcpServer, type DhcpServerHandle } from '../../src/runHosting/dhcpServer';
let handle: DhcpServerHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});
function discover() {
  const b = Buffer.alloc(300);
  b[0] = 1;
  b[1] = 1;
  b[2] = 6;
  b.writeUInt32BE(0x5150, 4);
  Buffer.from([0, 0x15, 0x5d, 0, 0x71, 0x10]).copy(b, 28);
  b.writeUInt32BE(0x63825363, 236);
  b[240] = 53;
  b[241] = 1;
  b[242] = 1;
  b[243] = 255;
  return b;
}
describe('DHCP serving', () => {
  it('replies to DISCOVER', async () => {
    const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((r) => client.bind(0, '127.0.0.1', r));
    const port = client.address().port;
    handle = await startDhcpServer({
      listenAddress: '127.0.0.1',
      netmask: '255.255.255.0',
      port: 0,
      clientPort: port,
    });
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 2000);
      client.on('message', (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      client.send(discover(), handle!.port, '127.0.0.1');
    });
    expect(reply[0]).toBe(2);
    expect(reply.readUInt32BE(4)).toBe(0x5150);
    client.close();
  });
  it('rejects invalid bind', async () => {
    await expect(
      startDhcpServer({ listenAddress: '203.0.113.9', netmask: '255.255.255.0', port: 0 }),
    ).rejects.toThrow();
  });
});
