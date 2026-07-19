import { describe, it, expect } from 'vitest';
import { formatGithubSecret } from '../../src/githubSecret';

describe('formatGithubSecret', () => {
  it('renders both SDS resources with Basic and Bearer inline strings', () => {
    const token = 'github_pat_' + 'A'.repeat(82);
    const basic = 'Basic ' + Buffer.from(`octocat:${token}`).toString('base64');

    expect(formatGithubSecret('octocat', token)).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: github_basic_auth',
        '    generic_secret:',
        '      secret:',
        `        inline_string: "${basic}"`,
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: github_api_token',
        '    generic_secret:',
        '      secret:',
        `        inline_string: "Bearer ${token}"`,
        '',
      ].join('\n'),
    );
  });

  it('base64-encodes the username:token pair for the Basic resource', () => {
    const out = formatGithubSecret('Test User', 'github_pat_xyz');
    const expected = Buffer.from('Test User:github_pat_xyz').toString('base64');
    expect(out).toContain(`inline_string: "Basic ${expected}"`);
  });
});
