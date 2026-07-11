import { describe, it, expect } from 'vitest';
import { UniqueTracker } from '../../../src/runProxy/uniqueTracker';
import type { Entry } from '../../../src/runProxy/classify';

function e(domain: string, tag: Entry['tag'] = 'ALLOW PASS'): Entry {
  return { time: '2026-07-10T12:00:00', tag, domain };
}

describe('UniqueTracker', () => {
  it('prints the first occurrence of each tag+domain only', () => {
    const t = new UniqueTracker();
    expect(t.shouldPrint(e('github.com'))).toBe(true);
    expect(t.shouldPrint(e('github.com'))).toBe(false);
    // different tag for the same domain is a different key
    expect(t.shouldPrint(e('github.com', 'BLOCK TLS'))).toBe(true);
    // different domain is a different key
    expect(t.shouldPrint(e('pypi.org'))).toBe(true);
  });

  it('clear() forgets everything so previously-seen keys print again', () => {
    const t = new UniqueTracker();
    expect(t.shouldPrint(e('github.com'))).toBe(true);
    t.clear();
    expect(t.shouldPrint(e('github.com'))).toBe(true);
  });
});
