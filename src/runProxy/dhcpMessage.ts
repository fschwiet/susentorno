import { intToIp, ipToInt } from './ip';
export const DHCP = {
  DISCOVER: 1,
  OFFER: 2,
  REQUEST: 3,
  DECLINE: 4,
  ACK: 5,
  NAK: 6,
  RELEASE: 7,
  INFORM: 8,
} as const;
const COOKIE = 0x63825363;
const MIN = 240;
const END = 255;
const PAD = 0;
const MT = 53;
const MASK = 1;
const ROUTER = 3;
const DNS = 6;
const REQ = 50;
const LEASE = 51;
const SERVER = 54;
const CLIENT = 61;
const T1 = 58;
const T2 = 59;
export interface DhcpPacket {
  op: number;
  xid: number;
  flags: number;
  ciaddr: string;
  giaddr: string;
  chaddr: Buffer;
  messageType: number;
  options: Map<number, Buffer>;
}
const readIp = (b: Buffer, o: number) => intToIp(b.readUInt32BE(o));
const writeIp = (b: Buffer, o: number, ip: string) => b.writeUInt32BE(ipToInt(ip), o);
export function parsePacket(buf: Buffer): DhcpPacket | null {
  if (buf.length < MIN || buf.readUInt32BE(236) !== COOKIE) return null;
  const hlen = buf.readUInt8(2);
  if (hlen < 1 || hlen > 16) return null;
  const options = new Map<number, Buffer>();
  let off = MIN;
  for (;;) {
    if (off >= buf.length) return null;
    const code = buf.readUInt8(off);
    if (code === END) break;
    if (code === PAD) {
      off++;
      continue;
    }
    if (off + 1 >= buf.length) return null;
    const len = buf.readUInt8(off + 1);
    if (off + 2 + len > buf.length) return null;
    options.set(code, buf.subarray(off + 2, off + 2 + len));
    off += 2 + len;
  }
  const type = options.get(MT);
  if (!type || type.length !== 1) return null;
  return {
    op: buf.readUInt8(0),
    xid: buf.readUInt32BE(4),
    flags: buf.readUInt16BE(10),
    ciaddr: readIp(buf, 12),
    giaddr: readIp(buf, 24),
    chaddr: Buffer.from(buf.subarray(28, 28 + hlen)),
    messageType: type.readUInt8(0),
    options,
  };
}
export function clientIdentity(pkt: DhcpPacket): string {
  return (pkt.options.get(CLIENT) ?? pkt.chaddr).toString('hex');
}
export function requestedAddress(pkt: DhcpPacket): string | null {
  const o = pkt.options.get(REQ);
  return o && o.length === 4 ? intToIp(o.readUInt32BE(0)) : null;
}
export function serverIdentifier(pkt: DhcpPacket): string | null {
  const o = pkt.options.get(SERVER);
  return o && o.length === 4 ? intToIp(o.readUInt32BE(0)) : null;
}
export interface BuildReplyInput {
  request: DhcpPacket;
  messageType: number;
  yiaddr: string;
  hostIp: string;
  netmask: string;
  leaseSeconds: number;
}
export function buildReply(i: BuildReplyInput): Buffer {
  const b = Buffer.alloc(300);
  b.writeUInt8(2, 0);
  b.writeUInt8(1, 1);
  b.writeUInt8(i.request.chaddr.length, 2);
  b.writeUInt32BE(i.request.xid, 4);
  b.writeUInt16BE(i.request.flags, 10);
  writeIp(b, 12, i.request.ciaddr);
  writeIp(b, 16, i.yiaddr);
  writeIp(b, 20, i.hostIp);
  writeIp(b, 24, i.request.giaddr);
  i.request.chaddr.copy(b, 28);
  b.writeUInt32BE(COOKIE, 236);
  let o = MIN;
  const opt = (c: number, v: Buffer) => {
    b.writeUInt8(c, o++);
    b.writeUInt8(v.length, o++);
    v.copy(b, o);
    o += v.length;
  };
  const u32 = (n: number) => {
    const x = Buffer.alloc(4);
    x.writeUInt32BE(n, 0);
    return x;
  };
  const ip = (s: string) => u32(ipToInt(s));
  opt(MT, Buffer.from([i.messageType]));
  opt(SERVER, ip(i.hostIp));
  if (i.messageType !== DHCP.NAK) {
    opt(MASK, ip(i.netmask));
    opt(ROUTER, ip(i.hostIp));
    opt(DNS, ip(i.hostIp));
    opt(LEASE, u32(i.leaseSeconds));
    opt(T1, u32(Math.floor(i.leaseSeconds * 0.5)));
    opt(T2, u32(Math.floor(i.leaseSeconds * 0.875)));
  }
  b.writeUInt8(END, o++);
  return b.subarray(0, o);
}
