import { describe, it, expect } from 'vitest';
import { validateGithubTokenFormat } from '../../src/githubToken';

describe('validateGithubTokenFormat', () => {
  it('accepts a well-formed fine-grained token', () => {
    const token = 'github_pat_' + 'A'.repeat(82);
    expect(validateGithubTokenFormat(token)).toBeNull();
  });

  it('rejects a token with the wrong prefix', () => {
    const token = 'ghp_' + 'A'.repeat(89);
    expect(validateGithubTokenFormat(token)).toBe('token must start with "github_pat_"');
  });

  it('rejects a truncated token', () => {
    const token = 'github_pat_' + 'A'.repeat(40);
    expect(validateGithubTokenFormat(token)).toBe('token must be 93 characters long, got 51');
  });

  it('rejects a token with invalid characters after the prefix', () => {
    const token = 'github_pat_' + 'A'.repeat(81) + '!';
    expect(validateGithubTokenFormat(token)).toBe(
      'token must contain only letters, digits, and underscores after the prefix',
    );
  });
});
