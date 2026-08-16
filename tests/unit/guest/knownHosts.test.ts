import { describe, expect, it } from 'vitest';
import { appendKnownHostsLine, buildKnownHostsLine } from '../../guest/knownHosts';
const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHOSTKEY susentorno-test-guest';
describe('known hosts', () => {
  it('trusts an exact IP with the key type and blob only', () => {
    expect(buildKnownHostsLine('192.168.68.42', key)).toBe(
      '192.168.68.42 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHOSTKEY',
    );
  });
  it('rejects malformed public keys', () => {
    expect(() => buildKnownHostsLine('10.0.0.1', 'garbage')).toThrow(/not an ssh public key/);
  });
  it('preserves unrelated content and is idempotent', () => {
    const line = buildKnownHostsLine('192.168.68.42', key);
    const once = appendKnownHostsLine('github.com ssh-rsa AAAA\n', line);
    expect(once).toBe(`github.com ssh-rsa AAAA\n${line}\n`);
    expect(appendKnownHostsLine(once, line)).toBe(once);
  });
});
