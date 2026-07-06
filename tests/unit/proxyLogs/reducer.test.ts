import { describe, it, expect } from 'vitest';
import { Reducer } from '../../../src/proxyLogs/reducer';
import type { Entry } from '../../../src/proxyLogs/classify';

function e(time: string, domain = 'github.com', tag: Entry['tag'] = 'ALLOW PASS'): Entry {
  return { time: `2026-07-06T${time}`, tag, domain };
}

describe('Reducer', () => {
  it('all mode emits every entry as a plain line', () => {
    const r = new Reducer({ kind: 'all' });
    expect(r.push(e('12:00:00'))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW PASS', domain: 'github.com' },
    ]);
    expect(r.push(e('12:00:01'))).toHaveLength(1);
  });

  it('unique mode emits the first occurrence of each key only', () => {
    const r = new Reducer({ kind: 'unique' });
    expect(r.push(e('12:00:00'))).toHaveLength(1);
    expect(r.push(e('12:00:05'))).toEqual([]);
    // different tag for the same domain is a different key
    expect(r.push(e('12:00:06', 'github.com', 'BLOCK TLS'))).toHaveLength(1);
  });

  it('debounce mode suppresses within the window and reprints with a count', () => {
    const r = new Reducer({ kind: 'debounce', windowMs: 30_000 });
    expect(r.push(e('12:00:00'))).toHaveLength(1); // first print
    expect(r.push(e('12:00:10'))).toEqual([]); // +10s suppressed
    expect(r.push(e('12:00:20'))).toEqual([]); // +20s suppressed
    const out = r.push(e('12:00:31')); // +31s -> reprint
    expect(out).toEqual([
      {
        time: '2026-07-06T12:00:31',
        tag: 'ALLOW PASS',
        domain: 'github.com',
        count: 2,
        since: '2026-07-06T12:00:00',
      },
    ]);
    // window resets from the reprint
    expect(r.push(e('12:00:40'))).toEqual([]);
  });

  it('debounce tracks each key independently', () => {
    const r = new Reducer({ kind: 'debounce', windowMs: 30_000 });
    expect(r.push(e('12:00:00', 'a'))).toHaveLength(1);
    expect(r.push(e('12:00:01', 'b'))).toHaveLength(1);
  });
});
