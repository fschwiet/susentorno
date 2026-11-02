import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import {
  CA_COMMON_NAME_PREFIX,
  LEAF_COMMON_NAME,
  generateRootCa,
  generateLeaf,
  validateCaPair,
  isSignedBy,
  namesIssuerByKey,
  certSans,
} from '../../src/ca';

describe('CA creation', () => {
  describe('root CA issuance', () => {
    const ca = generateRootCa();

    it('is a self-signed CA with the susentorno CN and no server SANs', () => {
      const cert = new X509Certificate(ca.caCertPem);
      expect(cert.subject).toContain(CA_COMMON_NAME_PREFIX);
      expect(cert.issuer).toContain(CA_COMMON_NAME_PREFIX); // self-signed
      expect(cert.ca).toBe(true);
      expect(cert.subjectAltName).toBeUndefined();
    });

    it('is a matching cert/key pair', () => {
      expect(validateCaPair(ca.caCertPem, ca.caKeyPem)).toBe(true);
    });

    it('gives every root its own subject, so two susentorno roots never share an issuer name', () => {
      const other = generateRootCa();
      const subjects = [ca, other].map((root) => new X509Certificate(root.caCertPem).subject);
      for (const subject of subjects) {
        expect(subject).toMatch(new RegExp(`^CN=${CA_COMMON_NAME_PREFIX}-[0-9a-f]{8}$`));
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
      expect(cert.issuer).toContain(CA_COMMON_NAME_PREFIX);
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
      expect(forge.util.bytesToHex(leafAki!.value)).toMatch(
        new RegExp(`${rootSki!.subjectKeyIdentifier}$`),
      );
      expect(namesIssuerByKey(leaf.leafCertPem, ca.caCertPem)).toBe(true);
      expect(namesIssuerByKey(leaf.leafCertPem, generateRootCa().caCertPem)).toBe(false);
    });

    it('names by key a root that carries no subject key identifier extension', () => {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = '01';
      cert.validity.notBefore = new Date();
      cert.validity.notAfter = new Date(Date.now() + 86_400_000);
      const attrs = [{ name: 'commonName', value: 'root-without-ski' }];
      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      const rootPem = forge.pki.certificateToPem(cert);
      const issued = generateLeaf(rootPem, forge.pki.privateKeyToPem(keys.privateKey), [
        'a.invalid',
      ]);
      expect(isSignedBy(issued.leafCertPem, rootPem)).toBe(true);
      expect(namesIssuerByKey(issued.leafCertPem, rootPem)).toBe(true);
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
