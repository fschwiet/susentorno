import { describe, expect, it } from 'vitest';
import { parseSha256Sums } from '../../guest/hyperv/isoCache';

const sums = [
  'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef *ubuntu-26.04-desktop-amd64.iso',
  'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100 *ubuntu-26.04-live-server-amd64.iso',
  '',
].join('\n');

describe('parseSha256Sums', () => {
  it('finds only the digest for the exact filename', () => {
    expect(parseSha256Sums(sums, 'ubuntu-26.04-live-server-amd64.iso')).toBe(
      'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
    );
    expect(parseSha256Sums(sums, 'ubuntu-26.04-desktop-amd64.iso')).toBe(
      'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef',
    );
  });
  it('accepts a text-mode checksum entry and rejects missing or suffix-only names', () => {
    expect(parseSha256Sums('abc123  some-file.iso\n', 'some-file.iso')).toBe('abc123');
    expect(() => parseSha256Sums(sums, 'ubuntu-27.04-live-server-amd64.iso')).toThrow(
      /ubuntu-27\.04/,
    );
    expect(() => parseSha256Sums(sums, 'server-amd64.iso')).toThrow();
  });
});
