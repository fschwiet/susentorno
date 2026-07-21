import { describe, it, expect } from 'vitest';
import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_EXP_SECONDS,
  CODEX_PLACEHOLDER_ID_TOKEN,
  CODEX_PLACEHOLDER_REFRESH_TOKEN,
} from '../../src/codexPlaceholder';
import { jwtExpMs } from '../../src/jwt';

describe('codex placeholder constants', () => {
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
});
