import { describe, expect, it } from 'vitest';
import { parseAgentFingerprints, parseFingerprint } from '../sshAgentIdentity';
describe('ssh agent fingerprints', () => {
  it('parses ssh-keygen output', () => {
    expect(parseFingerprint('256 SHA256:abc123DEF/ghi+jkl key (ED25519)\n')).toBe(
      'SHA256:abc123DEF/ghi+jkl',
    );
    expect(parseFingerprint('bad')).toBeNull();
  });
  it('parses all agent identities', () => {
    expect(
      parseAgentFingerprints(
        '256 SHA256:aaa/AAA+111 personal (ED25519)\n3072 SHA256:bbb/BBB+222 work (RSA)\n',
      ),
    ).toEqual(['SHA256:aaa/AAA+111', 'SHA256:bbb/BBB+222']);
  });
});
