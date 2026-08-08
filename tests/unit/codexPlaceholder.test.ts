import { describe, it, expect } from 'vitest';
import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_ACCOUNT_ID,
  CODEX_PLACEHOLDER_EXP_SECONDS,
  CODEX_PLACEHOLDER_ID_TOKEN,
  CODEX_PLACEHOLDER_REFRESH_TOKEN,
} from '../../src/codexPlaceholder';
import { decodeJwtClaims, jwtExpMs } from '../../src/jwt';

describe('Codex placeholder credential constants', () => {
  it('exp is ~year 2100 (well past any real session)', () => {
    expect(CODEX_PLACEHOLDER_EXP_SECONDS).toBe(4102444800);
  });

  it('access and id tokens are valid JWTs whose exp decodes to the far-future value', () => {
    expect(jwtExpMs(CODEX_PLACEHOLDER_ACCESS_TOKEN)).toBe(4102444800 * 1000);
    expect(jwtExpMs(CODEX_PLACEHOLDER_ID_TOKEN)).toBe(4102444800 * 1000);
  });

  it('carries no real-looking secret material', () => {
    expect(CODEX_PLACEHOLDER_REFRESH_TOKEN).toContain('placeholder');
  });

  it('documents the exact claim set carried by the placeholder access/id tokens', () => {
    const expectedClaims = {
      sub: 'susentorno-user',
      email: 'susentorno@susentorno.invalid',
      exp: 4102444800,
      'https://api.openai.com/auth': {
        chatgpt_account_id: CODEX_PLACEHOLDER_ACCOUNT_ID,
      },
    };
    expect(decodeJwtClaims(CODEX_PLACEHOLDER_ACCESS_TOKEN)).toEqual(expectedClaims);
    expect(decodeJwtClaims(CODEX_PLACEHOLDER_ID_TOKEN)).toEqual(expectedClaims);
  });

  it('account id placeholder is a fixed, non-empty, obviously-fake string', () => {
    expect(CODEX_PLACEHOLDER_ACCOUNT_ID).toBe('susentorno-placeholder-account-id');
  });
});
