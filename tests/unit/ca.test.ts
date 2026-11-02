import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import {
  CA_COMMON_NAME,
  LEAF_COMMON_NAME,
  generateRootCa,
  generateLeaf,
  validateCaPair,
  isSignedBy,
  certSans,
} from '../../src/ca';

describe('CA creation', () => {
  describe('root CA issuance', () => {
    const ca = generateRootCa();

    it('is a self-signed CA with the susentorno CN and no server SANs', () => {
      const cert = new X509Certificate(ca.caCertPem);
      expect(cert.subject).toContain(CA_COMMON_NAME);
      expect(cert.issuer).toContain(CA_COMMON_NAME); // self-signed
      expect(cert.ca).toBe(true);
      expect(cert.subjectAltName).toBeUndefined();
    });

    it('is a matching cert/key pair', () => {
      expect(validateCaPair(ca.caCertPem, ca.caKeyPem)).toBe(true);
    });

    it('gives every root its own subject, so two susentorno roots never share an issuer name', () => {
      // A guest can trust two susentorno roots at once (an ambient one copied
      // from the host plus the environment's own). With one fixed name, a
      // verifier looking up a leaf's issuer by name could pick the wrong
      // root and fail with "certificate signature failure".
      const other = generateRootCa();
      const subjects = [ca, other].map((root) => new X509Certificate(root.caCertPem).subject);
      for (const subject of subjects) {
        expect(subject).toMatch(new RegExp(`^CN=${CA_COMMON_NAME}-[0-9a-f]{8}$`));
      }
      expect(subjects[0]).not.toBe(subjects[1]);
    });
  });

  describe('leaf issuance', () => {
    const ca = generateRootCa();
    const sans = ['api.anthropic.com', 'claude.com'];
    const leaf = generateLeaf(ca.caCertPem, ca.caKeyPem, sans);

    it('is a non-CA cert carrying the given SANs, issued by the root', () => {
      const cert = new X509Certificate(leaf.leafCertPem);
      expect(cert.subject).toContain(LEAF_COMMON_NAME);
      expect(cert.issuer).toContain(CA_COMMON_NAME);
      expect(cert.ca).toBe(false);
      for (const san of sans) expect(cert.subjectAltName).toContain(`DNS:${san}`);
    });

    it("names its root by key: the authority key identifier is the root's subject key identifier", () => {
      const rootSki = forge.pki
        .certificateFromPem(ca.caCertPem)
        .getExtension('subjectKeyIdentifier') as { subjectKeyIdentifier: string } | null;
      const leafAki = forge.pki
        .certificateFromPem(leaf.leafCertPem)
        .getExtension('authorityKeyIdentifier') as { value: string } | null;
      expect(rootSki).not.toBeNull();
      expect(leafAki).not.toBeNull();
      // AuthorityKeyIdentifier ::= SEQUENCE { [0] keyIdentifier, ... }: 30 16 80 14 <20-byte id>
      expect(forge.util.bytesToHex(leafAki!.value)).toBe(
        `30168014${rootSki!.subjectKeyIdentifier}`,
      );
    });

    it('verifies against the root public key', () => {
      expect(isSignedBy(leaf.leafCertPem, ca.caCertPem)).toBe(true);
    });

    it('is a matching cert/key pair', () => {
      expect(validateCaPair(leaf.leafCertPem, leaf.leafKeyPem)).toBe(true);
    });
  });
});

describe('CA validation', () => {
  describe('signing verification', () => {
    it('rejects a leaf signed by a different root', () => {
      const a = generateRootCa();
      const b = generateRootCa();
      const leaf = generateLeaf(a.caCertPem, a.caKeyPem, ['api.anthropic.com']);
      expect(isSignedBy(leaf.leafCertPem, a.caCertPem)).toBe(true);
      expect(isSignedBy(leaf.leafCertPem, b.caCertPem)).toBe(false);
    });
  });

  describe('SAN extraction', () => {
    it('extracts DNS SANs', () => {
      const ca = generateRootCa();
      const leaf = generateLeaf(ca.caCertPem, ca.caKeyPem, ['api.anthropic.com', 'claude.com']);
      expect(certSans(leaf.leafCertPem).sort()).toEqual(['api.anthropic.com', 'claude.com']);
    });
  });

  describe('key pair validation', () => {
    it('rejects garbage and mismatched pairs', () => {
      const a = generateRootCa();
      const b = generateRootCa();
      expect(validateCaPair('garbage', a.caKeyPem)).toBe(false);
      expect(validateCaPair(a.caCertPem, 'garbage')).toBe(false);
      expect(validateCaPair(a.caCertPem, b.caKeyPem)).toBe(false);
    });
  });
});
