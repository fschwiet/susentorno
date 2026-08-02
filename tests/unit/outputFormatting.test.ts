import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../src/runHosting/formatOutput';

describe('access-log output formatting', () => {
  it('formats an entry as time  TAG  domain', () => {
    expect(
      formatOutput({ time: '2026-07-06T12:04:31', tag: 'BLOCK TLS', domain: 'nope.example.com' }),
    ).toBe('12:04:31  BLOCK TLS  nope.example.com');
  });

  it('formats an AUTH CANDIDATE entry with protocol and header=value', () => {
    expect(
      formatOutput({
        time: '2026-07-18T09:00:00',
        tag: 'AUTH CANDIDATE',
        domain: 'partner.example.com',
        protocol: 'https',
        header: 'Authorization',
        value: 'Bearer abc12',
      }),
    ).toBe('09:00:00  AUTH CANDIDATE  partner.example.com  https  Authorization=Bearer abc12');
  });
});
