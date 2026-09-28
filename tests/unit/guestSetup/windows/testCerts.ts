import { createHash } from 'node:crypto';
import forge from 'node-forge';

let sharedKeys: forge.pki.rsa.KeyPair | undefined;

/**
 * A real, parseable self-signed certificate per common name. One small key pair is
 * reused so a test can mint several certificates cheaply; the DER (and so the
 * SHA-256) differs per common name.
 */
export function makeCertificate(commonName: string): { pem: string; sha256: string } {
  sharedKeys ??= forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = sharedKeys.publicKey;
  cert.serialNumber = '01' + createHash('sha1').update(commonName).digest('hex').slice(0, 14);
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2036-01-01T00:00:00Z');
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }]);
  cert.sign(sharedKeys.privateKey, forge.md.sha256.create());
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  return {
    pem: forge.pki.certificateToPem(cert),
    sha256: createHash('sha256').update(der).digest('hex'),
  };
}
