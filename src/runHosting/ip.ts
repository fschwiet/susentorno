export function ipToInt(ip: string): number {
  const parts = ip.split('.');
  return (
    ((Number(parts[0]) << 24) >>> 0) +
    (Number(parts[1]) << 16) +
    (Number(parts[2]) << 8) +
    Number(parts[3])
  );
}
export function intToIp(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    '.',
  );
}
export function networkAddress(ip: string, netmask: string): number {
  return (ipToInt(ip) & ipToInt(netmask)) >>> 0;
}
export function prefixLength(netmask: string): number {
  let bits = 0;
  let mask = ipToInt(netmask);
  while (mask & 0x80000000) {
    bits++;
    mask = (mask << 1) >>> 0;
  }
  return bits;
}
