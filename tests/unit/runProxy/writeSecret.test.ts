import { describe, it, expect } from 'vitest';
import { formatSecret } from '../../../src/runProxy/writeSecret';

describe('formatSecret', () => {
  it('emits the SDS secret structure with a Bearer-prefixed inline_string', () => {
    expect(formatSecret('sk-ant-oat01-xyz')).toBe(
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
});
