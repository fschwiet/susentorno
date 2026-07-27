import { describe, it, expect } from 'vitest';
import { buildJwt, decodeJwtClaims, encodeBase64Url, jwtExpMs } from '../../src/jwt';

describe('JWT build/decode helpers', () => {
  it('round-trips claims through buildJwt/decodeJwtClaims', () => {
    const token = buildJwt({ sub: 'x', exp: 4102444800 });
    expect(decodeJwtClaims(token)).toEqual({ sub: 'x', exp: 4102444800 });
  });

  it('derives exp in epoch milliseconds', () => {
    const token = buildJwt({ exp: 1751234567 });
    expect(jwtExpMs(token)).toBe(1751234567 * 1000);
  });

  it('produces url-safe base64 with no padding', () => {
    const s = encodeBase64Url(Buffer.from([0xff, 0xff, 0xfe]).toString('binary'));
    expect(s).not.toMatch(/[+/=]/);
  });

  it('returns null for a non-three-part token', () => {
    expect(decodeJwtClaims('not.ajwt')).toBeNull();
    expect(jwtExpMs('not.ajwt')).toBeNull();
  });

  it('returns null when exp is missing or non-numeric', () => {
    expect(jwtExpMs(buildJwt({ sub: 'x' }))).toBeNull();
    expect(jwtExpMs(buildJwt({ exp: 'soon' }))).toBeNull();
  });

  it('returns null when exp decodes to a non-finite number', () => {
    // JSON.parse('1e999') === Infinity, which is typeof 'number'.
    const token = `${encodeBase64Url({ alg: 'none' })}.${encodeBase64Url('{"exp":1e999}')}.sig`;
    expect(jwtExpMs(token)).toBeNull();
  });

  it('returns null on a payload that is not JSON', () => {
    const bad = `${encodeBase64Url({ a: 1 })}.notbase64json!!.sig`;
    expect(decodeJwtClaims(bad)).toBeNull();
  });
});
