import { describe, it, expect } from 'vitest';
import { formatSecret } from '../../src/runProxy/writeSecret';

describe('credential secret formatting', () => {
  it('emits the SDS secret structure with a Bearer-prefixed inline_string and the given resource name', () => {
    expect(formatSecret('sk-ant-oat01-xyz', 'sandbox_bearer_token')).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: sandbox_bearer_token',
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
});
