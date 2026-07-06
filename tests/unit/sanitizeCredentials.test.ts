import { describe, it, expect } from 'vitest';
import {
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_EXPIRES_AT,
  PLACEHOLDER_REFRESH_TOKEN,
  sanitizeCredentials,
} from '../../src/sanitizeCredentials';

const realCredentials = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat-REAL-SECRET',
    refreshToken: 'real-refresh-secret',
    expiresAt: 1751234567890,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'pro',
    rateLimitTier: 'default_claude_ai',
  },
});

describe('sanitizeCredentials', () => {
  it('replaces tokens and expiry with placeholders, passing other fields through', () => {
    const output = sanitizeCredentials(realCredentials);
    const parsed = JSON.parse(output);
    expect(parsed.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN);
    expect(parsed.claudeAiOauth.refreshToken).toBe(PLACEHOLDER_REFRESH_TOKEN);
    expect(parsed.claudeAiOauth.expiresAt).toBe(PLACEHOLDER_EXPIRES_AT);
    expect(parsed.claudeAiOauth.scopes).toEqual(['user:inference', 'user:profile']);
    expect(parsed.claudeAiOauth.subscriptionType).toBe('pro');
    expect(parsed.claudeAiOauth.rateLimitTier).toBe('default_claude_ai');
    expect(output).not.toContain('REAL-SECRET');
    expect(output).not.toContain('real-refresh-secret');
  });

  it('emits LF-only output ending with a newline', () => {
    const output = sanitizeCredentials(realCredentials);
    expect(output).not.toContain('\r');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('throws on invalid JSON', () => {
    expect(() => sanitizeCredentials('{nope')).toThrow('not valid JSON');
  });

  it('throws when claudeAiOauth is missing', () => {
    expect(() => sanitizeCredentials('{"other": true}')).toThrow('claudeAiOauth');
  });
});
