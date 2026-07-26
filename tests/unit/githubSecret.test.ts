import { describe, it, expect } from 'vitest';
import { formatGithubBasicSecret, formatGithubApiTokenSecret } from '../../src/githubSecret';

describe('GitHub credential secret formatting — Basic SDS', () => {
  it('renders the single Basic SDS resource as an inline string', () => {
    const token = 'github_pat_' + 'A'.repeat(82);
    const basic = 'Basic ' + Buffer.from(`octocat:${token}`).toString('base64');

    expect(formatGithubBasicSecret('octocat', token)).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: github_basic_auth',
        '    generic_secret:',
        '      secret:',
        `        inline_string: "${basic}"`,
        '',
      ].join('\n'),
    );
  });

  it('base64-encodes the username:token pair', () => {
    const out = formatGithubBasicSecret('Test User', 'github_pat_xyz');
    const expected = Buffer.from('Test User:github_pat_xyz').toString('base64');
    expect(out).toContain(`inline_string: "Basic ${expected}"`);
  });
});

describe('GitHub credential secret formatting — api token SDS', () => {
  it('renders the single token-scheme SDS resource as an inline string', () => {
    const token = 'github_pat_' + 'B'.repeat(82);

    expect(formatGithubApiTokenSecret(token)).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: github_api_token',
        '    generic_secret:',
        '      secret:',
        `        inline_string: "token ${token}"`,
        '',
      ].join('\n'),
    );
  });
});
