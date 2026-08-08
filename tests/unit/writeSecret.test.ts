import { describe, it, expect } from 'vitest';
import { formatPlainSecret, formatSecret } from '../../src/runHosting/writeSecret';

describe('credential secret formatting', () => {
  it('emits the SDS secret structure with a Bearer-prefixed inline_string and the given resource name', () => {
    expect(formatSecret('sk-ant-oat01-xyz', 'susentorno_bearer_token')).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: susentorno_bearer_token',
        '    generic_secret:',
        '      secret:',
        '        inline_string: "Bearer sk-ant-oat01-xyz"',
        '',
      ].join('\n'),
    );
  });

  it('uses the codex resource name when asked', () => {
    expect(formatSecret('codex-tok', 'codex_bearer_token')).toContain('name: codex_bearer_token');
  });

  it('formatPlainSecret emits the SDS secret structure with an unprefixed inline_string', () => {
    expect(formatPlainSecret('acct-uuid-1234', 'codex_account_id')).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: codex_account_id',
        '    generic_secret:',
        '      secret:',
        '        inline_string: "acct-uuid-1234"',
        '',
      ].join('\n'),
    );
  });

  it('formatSecret is formatPlainSecret with a Bearer prefix', () => {
    expect(formatSecret('tok', 'r')).toBe(formatPlainSecret('Bearer tok', 'r'));
  });
});
