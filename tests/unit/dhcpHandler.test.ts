import { describe, it, expect } from 'vitest';
import { handleDhcp } from '../../src/runProxy/dhcpHandler';
import { DHCP, parsePacket } from '../../src/runProxy/dhcpMessage';
import { createLeaseTable } from '../../src/runProxy/dhcpLeases';
const base = () => ({
  hostIp: '192.168.67.1',
  netmask: '255.255.255.0',
  leaseSeconds: 3600,
  leases: createLeaseTable({
    hostIp: '192.168.67.1',
    netmask: '255.255.255.0',
    leaseSeconds: 3600,
  }),
});
function pkt(type: number, extra: Array<[number, Buffer]> = []) {
  const b = Buffer.alloc(300);
  b[0] = 1;
  b[1] = 1;
  b[2] = 6;
  b.writeUInt32BE(1, 4);
  Buffer.from([0, 0x15, 0x5d, 0, 0x71, 0x10]).copy(b, 28);
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
  return parsePacket(b)!;
}
function type(b: Buffer) {
  let o = 240;
  while (b[o] !== 255) {
    if (b[o] === 53) return b[o + 2];
    o += 2 + b[o + 1];
  }
  return 0;
}
describe('DHCP request handling (offer/ACK/relay)', () => {
  it('offers and ACKs', () => {
    const o = base();
    const offer = handleDhcp(pkt(DHCP.DISCOVER), o)!;
    expect(type(offer.buffer)).toBe(DHCP.OFFER);
    const ip = offer.buffer.subarray(16, 20);
    const ack = handleDhcp(
      pkt(DHCP.REQUEST, [
        [54, Buffer.from([192, 168, 67, 1])],
        [50, ip],
      ]),
      o,
    )!;
    expect(type(ack.buffer)).toBe(DHCP.ACK);
  });
  it('ignores another server and relays', () => {
    const o = base();
    expect(handleDhcp(pkt(DHCP.REQUEST, [[54, Buffer.from([10, 0, 0, 1])]]), o)).toBeNull();
    const p = pkt(DHCP.DISCOVER);
    p.giaddr = '10.0.0.1';
    expect(handleDhcp(p, o)).toBeNull();
  });
});
