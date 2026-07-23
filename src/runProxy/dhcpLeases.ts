import { intToIp, ipToInt, networkAddress } from './ip';
export interface LeaseTableOptions { hostIp: string; netmask: string; poolStart?: number; poolEnd?: number; leaseSeconds: number; now?: () => number; }
export interface LeaseTable { acquire(identity: string): string | null; request(identity: string, requested: string): 'ack' | 'nak'; release(identity: string): void; decline(address: string): void; }
interface Lease { identity: string; expiresAt: number; }
function hash32(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
export function createLeaseTable(opts: LeaseTableOptions): LeaseTable {
  const start = opts.poolStart ?? 10; const end = opts.poolEnd ?? 209; const size = end - start + 1; const base = networkAddress(opts.hostIp, opts.netmask); const host = ipToInt(opts.hostIp); const now = opts.now ?? Date.now; const leases = new Map<number, Lease>(); const declined = new Set<number>(); const addressAt = (slot: number) => (base + start + slot) >>> 0;
  const existing = (identity: string) => [...leases].find(([, l]) => l.identity === identity && l.expiresAt > now())?.[0] ?? null;
  const assign = (addr: number, identity: string) => leases.set(addr, { identity, expiresAt: now() + opts.leaseSeconds * 1000 });
  return {
    acquire(identity) { const old = existing(identity); if (old !== null) { assign(old, identity); return intToIp(old); } const preferred = hash32(identity) % size; for (let i = 0; i < size; i++) { const addr = addressAt((preferred + i) % size); const lease = leases.get(addr); if (addr !== host && !declined.has(addr) && (!lease || lease.expiresAt <= now())) { assign(addr, identity); return intToIp(addr); } } return null; },
    request(identity, requested) { const addr = ipToInt(requested); const first = addressAt(0); const last = addressAt(size - 1); if (addr < first || addr > last || addr === host || declined.has(addr)) return 'nak'; const lease = leases.get(addr); if (lease && lease.expiresAt > now() && lease.identity !== identity) return 'nak'; assign(addr, identity); return 'ack'; },
    release(identity) { const addr = existing(identity); if (addr !== null) leases.delete(addr); },
    decline(address) { const addr = ipToInt(address); declined.add(addr); leases.delete(addr); },
  };
}
