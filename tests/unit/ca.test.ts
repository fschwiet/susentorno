import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { CA_COMMON_NAME, CA_SANS, generateCaPems, validateCaPair } from '../../src/ca';

describe('generateCaPems', () => {
  // Key generation is slow; generate once and share across assertions.
  const pair = generateCaPems();

  it('generates a self-signed cert with the sandbox CN and all terminate hostnames', () => {
    const cert = new X509Certificate(pair.certPem);
    expect(cert.subject).toContain(CA_COMMON_NAME);
    for (const san of CA_SANS) {
      expect(cert.subjectAltName).toContain(`DNS:${san}`);
    }
    expect(CA_SANS).toContain('api.anthropic.com');
    expect(CA_SANS).toContain('downloads.claude.ai');
  });

  it('generates a matching cert/key pair', () => {
    expect(validateCaPair(pair.certPem, pair.keyPem)).toBe(true);
  });
});

describe('validateCaPair', () => {
  it('rejects garbage and mismatched pairs', () => {
    const a = generateCaPems();
    const b = generateCaPems();
    expect(validateCaPair('garbage', a.keyPem)).toBe(false);
    expect(validateCaPair(a.certPem, 'garbage')).toBe(false);
    expect(validateCaPair(a.certPem, b.keyPem)).toBe(false);
  });
});
