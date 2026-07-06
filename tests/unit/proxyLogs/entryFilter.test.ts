import { describe, it, expect } from 'vitest';
import { keepEntry } from '../../../src/proxyLogs/entryFilter';
import type { Entry } from '../../../src/proxyLogs/classify';

const allow: Entry = { time: 't', tag: 'ALLOW PASS', domain: 'a' };
const block: Entry = { time: 't', tag: 'BLOCK TLS', domain: 'b' };

describe('keepEntry', () => {
  it('keeps everything when blockedOnly is false', () => {
    expect(keepEntry(allow, false)).toBe(true);
    expect(keepEntry(block, false)).toBe(true);
  });

  it('keeps only BLOCK entries when blockedOnly is true', () => {
    expect(keepEntry(allow, true)).toBe(false);
    expect(keepEntry(block, true)).toBe(true);
    expect(keepEntry({ time: 't', tag: 'BLOCK HTTP', domain: 'c' }, true)).toBe(true);
  });
});
