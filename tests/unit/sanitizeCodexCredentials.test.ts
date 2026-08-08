import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sanitizeCodexCredentials } from '../../src/sanitizeCodexCredentials';
import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_ACCOUNT_ID,
  CODEX_PLACEHOLDER_ID_TOKEN,
  CODEX_PLACEHOLDER_REFRESH_TOKEN,
} from '../../src/codexPlaceholder';

const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));

describe('credential sanitization — codex credential channel', () => {
  it('replaces four token fields with placeholders and passes auth_mode/OPENAI_API_KEY through', () => {
    const output = sanitizeCodexCredentials(readFileSync(authFixture, 'utf8'));
    const parsed = JSON.parse(output);
    expect(parsed.tokens.access_token).toBe(CODEX_PLACEHOLDER_ACCESS_TOKEN);
    expect(parsed.tokens.id_token).toBe(CODEX_PLACEHOLDER_ID_TOKEN);
    expect(parsed.tokens.refresh_token).toBe(CODEX_PLACEHOLDER_REFRESH_TOKEN);
    // account_id is now placeholdered too — no real value ever enters the guest.
    expect(parsed.tokens.account_id).toBe(CODEX_PLACEHOLDER_ACCOUNT_ID);
    // auth_mode, OPENAI_API_KEY still pass through untouched.
    expect(parsed.auth_mode).toBe('chatgpt');
    expect(parsed.OPENAI_API_KEY).toBeNull();
    expect(output).not.toContain('real.access.token.value');
    expect(output).not.toContain('real-refresh-secret');
  });

  it('emits LF-only output ending with a newline', () => {
    const output = sanitizeCodexCredentials(readFileSync(authFixture, 'utf8'));
    expect(output).not.toContain('\r');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('throws on invalid JSON', () => {
    expect(() => sanitizeCodexCredentials('{nope')).toThrow('not valid JSON');
  });

  it('throws when tokens is missing', () => {
    expect(() => sanitizeCodexCredentials('{"auth_mode":"chatgpt"}')).toThrow('tokens');
  });

  it('refuses an api_key-mode file (would leak a real OPENAI_API_KEY)', () => {
    const apiKeyFile = JSON.stringify({
      OPENAI_API_KEY: 'sk-real-api-key',
      tokens: { access_token: 'whatever' },
      auth_mode: 'api_key',
    });
    expect(() => sanitizeCodexCredentials(apiKeyFile)).toThrow('chatgpt-mode');
  });
});
