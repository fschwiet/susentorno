/**
 * Minimal JWT helpers. We never verify signatures: we only read tokens we already
 * trust (our own auth.json) and emit garbage-signature placeholder tokens for the VM.
 */

/** JSON-encode (unless already a string) then base64url (RFC 7515) with padding stripped. */
export function encodeBase64Url(value: unknown): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Decode a JWT's payload claims without verifying the signature. Null on malformed. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Absolute expiry in epoch **milliseconds** from a JWT's `exp` claim (seconds). */
export function jwtExpMs(token: string): number | null {
  const claims = decodeJwtClaims(token);
  // NumericDate must be a finite number. Reject Infinity/NaN (e.g. a payload `exp: 1e999`
  // decodes to Infinity and would otherwise suppress refresh forever).
  if (!claims || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
  return claims.exp * 1000;
}

/** Build an unsigned-shape JWT (real 3 segments, garbage signature). */
export function buildJwt(claims: Record<string, unknown>): string {
  const header = encodeBase64Url({ alg: 'none', typ: 'JWT' });
  const payload = encodeBase64Url(claims);
  return `${header}.${payload}.susentorno-not-a-real-signature`;
}
