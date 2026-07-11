import type { Entry } from './classify';

/**
 * Tracks which host+handling pairs have already been printed. Replaces the old
 * proxy-logs Reducer: logging is always-unique now, so all that remains is a
 * seen-set — plus clear(), because an allowlist-triggered restart resets
 * tracking wholesale while a credential-triggered restart preserves it.
 */
export class UniqueTracker {
  private readonly seen = new Set<string>();

  /** True the first time a given tag+domain is seen (and records it). */
  shouldPrint(entry: Entry): boolean {
    const key = `${entry.tag} ${entry.domain}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}
