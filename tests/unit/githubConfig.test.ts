import { describe, it, expect } from 'vitest';
import { formatGithubConfig } from '../../src/githubConfig';

describe('GitHub credential configuration formatting', () => {
  it('writes username, email, and token as quoted shell variable assignments', () => {
    const content = formatGithubConfig({
      username: 'Test User',
      email: 'test@example.com',
      token: 'github_pat_abc123',
    });

    expect(content).toBe(
      [
        'GITHUB_USERNAME="Test User"',
        'GITHUB_EMAIL="test@example.com"',
        'GITHUB_TOKEN="github_pat_abc123"',
        '',
      ].join('\n'),
    );
  });
});
