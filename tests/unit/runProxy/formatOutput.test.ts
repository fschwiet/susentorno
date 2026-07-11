import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../../src/runProxy/formatOutput';

describe('formatOutput', () => {
  it('formats an entry as time  TAG  domain', () => {
    expect(
      formatOutput({ time: '2026-07-06T12:04:31', tag: 'BLOCK TLS', domain: 'nope.example.com' }),
    ).toBe('12:04:31  BLOCK TLS  nope.example.com');
  });
});
