import type { Entry } from './classify';

export function keepEntry(entry: Entry, blockedOnly: boolean): boolean {
  if (!blockedOnly) return true;
  return entry.tag === 'BLOCK TLS' || entry.tag === 'BLOCK HTTP';
}
