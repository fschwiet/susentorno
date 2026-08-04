import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../src/runHosting/formatOutput';

describe('access-log output formatting', () => {
  it('formats TLS and HTTP entries with domain:port', () => {
    expect(
      formatOutput({
        time: '2026-07-06T12:04:31',
        tag: 'BLOCK TLS',
        domain: 'nope.example.com',
        port: 443,
      }),
    ).toBe('12:04:31  BLOCK TLS  nope.example.com:443');
    expect(
      formatOutput({
        time: '2026-07-06T12:04:31',
        tag: 'ALLOW HTTP',
        domain: 'archive.ubuntu.com',
        port: 80,
      }),
    ).toBe('12:04:31  ALLOW HTTP  archive.ubuntu.com:80');
  });

  it('formats auth candidates with domain:port, protocol, and header=value', () => {
    expect(
      formatOutput({
        time: '2026-07-18T09:00:00',
        tag: 'AUTH CANDIDATE',
        domain: 'partner.example.com',
        port: 443,
        protocol: 'https',
        header: 'Authorization',
        value: 'Bearer abc12',
      }),
    ).toBe('09:00:00  AUTH CANDIDATE  partner.example.com:443  https  Authorization=Bearer abc12');
  });
});
