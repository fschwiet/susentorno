import { describe, it, expect } from 'vitest';
import { UniqueTracker } from '../../src/runHosting/uniqueTracker';
import type { Entry } from '../../src/runHosting/classify';

function e(domain: string, tag: Entry['tag'] = 'ALLOW PASS'): Entry {
  return { time: '2026-07-10T12:00:00', tag, domain };
}

describe('first-occurrence access-log deduplication', () => {
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

  it('dedups AUTH CANDIDATE per domain+header+value but reprints a new value', () => {
    const t = new UniqueTracker();
    const cand = (header: string, value: string): Entry => ({
      time: '2026-07-18T09:00:00',
      tag: 'AUTH CANDIDATE',
      domain: 'partner.example.com',
      protocol: 'https',
      header,
      value,
    });
    expect(t.shouldPrint(cand('Authorization', 'Bearer abc12'))).toBe(true);
    expect(t.shouldPrint(cand('Authorization', 'Bearer abc12'))).toBe(false);
    // a rotated value prints again
    expect(t.shouldPrint(cand('Authorization', 'Bearer xyz99'))).toBe(true);
    // a different header prints again
    expect(t.shouldPrint(cand('X-API-Key', 'Bearer abc12'))).toBe(true);
  });
});
