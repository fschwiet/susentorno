import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { startDnsResponder, type DnsResponderHandle } from '../../../src/runProxy/dnsResponder';

let handle: DnsResponderHandle | null = null;
afterEach(async () => { await handle?.close(); handle = null; });
function query(name: string, qtype = 1, id = 0x4242): Buffer { const labels = name.split('.'); const buf = Buffer.alloc(12 + labels.reduce((n, l) => n + 1 + l.length, 0) + 1 + 4); buf.writeUInt16BE(id, 0); buf.writeUInt16BE(0x0100, 2); buf.writeUInt16BE(1, 4); let off = 12; for (const l of labels) { buf.writeUInt8(l.length, off++); buf.write(l, off, 'ascii'); off += l.length; } buf.writeUInt8(0, off++); buf.writeUInt16BE(qtype, off); buf.writeUInt16BE(1, off + 2); return buf; }
function ask(port: number, packet: Buffer): Promise<Buffer> { return new Promise((resolve, reject) => { const sock = dgram.createSocket('udp4'); const timer = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, 2000); sock.on('message', (msg) => { clearTimeout(timer); sock.close(); resolve(msg); }); sock.send(packet, port, '127.0.0.1'); }); }

describe('startDnsResponder', () => {
  it('answers an A query with the configured IP', async () => { handle = await startDnsResponder({ listenAddress: '127.0.0.1', answerIp: '192.168.67.1', port: 0 }); const reply = await ask(handle.port, query('api.anthropic.com')); expect(reply.readUInt16BE(0)).toBe(0x4242); expect(reply.readUInt16BE(6)).toBe(1); expect([...reply.subarray(reply.length - 4)]).toEqual([192, 168, 67, 1]); });
  it('answers AAAA with NOERROR and no answer records', async () => { handle = await startDnsResponder({ listenAddress: '127.0.0.1', answerIp: '192.168.67.1', port: 0 }); const reply = await ask(handle.port, query('api.anthropic.com', 28)); expect(reply.readUInt16BE(6)).toBe(0); expect(reply.readUInt16BE(2) & 0x000f).toBe(0); });
  it('rejects a bind to an address the host does not own', async () => { await expect(startDnsResponder({ listenAddress: '203.0.113.9', answerIp: '203.0.113.9', port: 0 })).rejects.toThrow(); });
  it('close() releases the port', async () => { const h = await startDnsResponder({ listenAddress: '127.0.0.1', answerIp: '192.168.67.1', port: 0 }); const port = h.port; await h.close(); const again = await startDnsResponder({ listenAddress: '127.0.0.1', answerIp: '192.168.67.1', port }); expect(again.port).toBe(port); await again.close(); });
});
