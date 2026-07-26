import { describe, it, expect } from 'vitest';
import {
  DHCP,
  parsePacket,
  buildReply,
  clientIdentity,
  requestedAddress,
  serverIdentifier,
} from '../../src/runProxy/dhcpMessage';
const mac = Buffer.from([0, 0x15, 0x5d, 0, 0x71, 0x10]);
function packet(type: number, extra: Array<[number, Buffer]> = []): Buffer {
  const b = Buffer.alloc(300);
  b.writeUInt8(1, 0);
  b.writeUInt8(1, 1);
  b.writeUInt8(6, 2);
  b.writeUInt32BE(0xdeadbeef, 4);
  mac.copy(b, 28);
  b.writeUInt32BE(0x63825363, 236);
  let o = 240;
  b[o++] = 53;
  b[o++] = 1;
  b[o++] = type;
  for (const [c, v] of extra) {
    b[o++] = c;
    b[o++] = v.length;
    v.copy(b, o);
    o += v.length;
  }
  b[o] = 255;
  return b;
}
describe('DHCP message encode/decode', () => {
  it('parses and identifies clients/options', () => {
    const p = parsePacket(
      packet(DHCP.REQUEST, [
        [50, Buffer.from([192, 168, 67, 55])],
        [54, Buffer.from([192, 168, 67, 1])],
      ]),
    )!;
    expect(p.messageType).toBe(3);
    expect(clientIdentity(p)).toBe('00155d007110');
    expect(requestedAddress(p)).toBe('192.168.67.55');
    expect(serverIdentifier(p)).toBe('192.168.67.1');
  });
  it('rejects malformed packets', () => {
    expect(parsePacket(Buffer.alloc(100))).toBeNull();
    const b = packet(1);
    b.writeUInt32BE(0, 236);
    expect(parsePacket(b)).toBeNull();
  });
  it('builds addressing options and NAK', () => {
    const req = parsePacket(packet(1))!;
    const r = buildReply({
      request: req,
      messageType: DHCP.ACK,
      yiaddr: '192.168.67.10',
      hostIp: '192.168.67.1',
      netmask: '255.255.255.0',
      leaseSeconds: 3600,
    });
    expect(r.readUInt8(0)).toBe(2);
    expect(r.readUInt32BE(16)).toBe(0xc0a8430a);
    expect(r.readUInt8(242)).toBe(5);
  });
});
