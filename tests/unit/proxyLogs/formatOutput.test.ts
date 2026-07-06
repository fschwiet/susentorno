import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../../src/proxyLogs/formatOutput';

describe('formatOutput', () => {
  it('formats a plain line as time  TAG  domain', () => {
    expect(
      formatOutput({ time: '2026-07-06T12:04:31', tag: 'BLOCK TLS', domain: 'nope.example.com' }),
    ).toBe('12:04:31  BLOCK TLS  nope.example.com');
  });

  it('appends the collapsed count and since-time for a debounce reprint', () => {
    expect(
      formatOutput({
        time: '2026-07-06T12:04:31',
        tag: 'ALLOW PASS',
        domain: 'github.com',
        count: 47,
        since: '2026-07-06T12:04:01',
      }),
    ).toBe('12:04:31  ALLOW PASS  github.com  (x47 since 12:04:01)');
  });
});
