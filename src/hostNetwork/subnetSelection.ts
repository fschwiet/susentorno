import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { HostNetworkError } from './hostNetworkError';

export interface TakenRange {
  network: number;
  prefixLength: number;
}

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function prefixMask(prefixLength: number): number {
  return prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
}

function netmaskToPrefixLength(netmask: string): number {
  const bits = ipToInt(netmask).toString(2).padStart(32, '0');
  return bits.split('').filter((b) => b === '1').length;
}

/**
 * Every IPv4 address currently configured on any local adapter, reduced to
 * its network/prefix — read via os.networkInterfaces(), the same in-process
 * source resolveForwardListenAddress already uses, so no PowerShell
 * round-trip is needed for this.
 */
export function detectTakenRanges(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): TakenRange[] {
  const ranges: TakenRange[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4') continue;
      const prefixLength = netmaskToPrefixLength(info.netmask);
      const mask = prefixMask(prefixLength);
      ranges.push({ network: (ipToInt(info.address) & mask) >>> 0, prefixLength });
    }
  }
  return ranges;
}

function rangesOverlap(a: TakenRange, b: TakenRange): boolean {
  const mask = prefixMask(Math.min(a.prefixLength, b.prefixLength));
  return (a.network & mask) === (b.network & mask);
}

/**
 * True if 192.168.<n>.0/24 overlaps any detected range — not just an exact
 * third-octet match. A taken address with a broader prefix (e.g. a /16)
 * collides with every /24 inside it, not only the one matching its literal
 * third octet.
 */
export function isSubnetTaken(n: number, takenRanges: TakenRange[]): boolean {
  const candidate: TakenRange = { network: ipToInt(`192.168.${n}.0`), prefixLength: 24 };
  return takenRanges.some((range) => rangesOverlap(candidate, range));
}

/** Lowest free n in 0-255, or null if every 192.168.n.0/24 is taken. */
export function findFreeSubnet(takenRanges: TakenRange[]): number | null {
  for (let n = 0; n <= 255; n++) {
    if (!isSubnetTaken(n, takenRanges)) return n;
  }
  return null;
}

export function validateSubnet(n: number, takenRanges: TakenRange[]): void {
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new HostNetworkError(`Subnet value '${n}' is invalid (must be an integer 0-255).`);
  }
  if (isSubnetTaken(n, takenRanges)) {
    throw new HostNetworkError(
      `192.168.${n}.0/24 overlaps an address already in use on this host.`,
    );
  }
}
