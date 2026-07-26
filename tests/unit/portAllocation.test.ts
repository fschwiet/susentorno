import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { allocateColorPorts } from '../../src/runProxy/allocateColorPorts';

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

describe('loopback port allocation', () => {
  it('returns three distinct free loopback ports', async () => {
    const ports = await allocateColorPorts();
    const values = [ports.httpsPort, ports.httpPort, ports.adminPort];
    expect(new Set(values).size).toBe(3);
    for (const p of values) {
      expect(p).toBeGreaterThan(0);
      expect(await canBind(p)).toBe(true);
    }
  });
});
