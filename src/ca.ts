import { X509Certificate, createPrivateKey } from 'node:crypto';
import forge from 'node-forge';

export const CA_COMMON_NAME = 'configamatron-proxy-certificate-authority';
export const LEAF_COMMON_NAME = 'configamatron-proxy-leaf';

const VALIDITY_DAYS = 3650;

/** A positive DER serial (leading '00' keeps the INTEGER non-negative). */
function randomSerial(): string {
  return '00' + forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function validityDates(): { notBefore: Date; notAfter: Date } {
  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setDate(notAfter.getDate() + VALIDITY_DAYS);
  return { notBefore, notAfter };
}

/** Generate the durable root CA: CA:TRUE, keyCertSign, no server SANs. */
export function generateRootCa(): { caCertPem: string; caKeyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  const { notBefore, notAfter } = validityDates();
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [{ name: 'commonName', value: CA_COMMON_NAME }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed root
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    caCertPem: forge.pki.certificateToPem(cert),
    caKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** Issue a leaf for `sans`, signed by the given root. */
export function generateLeaf(
  caCertPem: string,
  caKeyPem: string,
  sans: string[],
): { leafCertPem: string; leafKeyPem: string } {
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  const { notBefore, notAfter } = validityDates();
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  cert.setSubject([{ name: 'commonName', value: LEAF_COMMON_NAME }]);
  cert.setIssuer(caCert.subject.attributes); // issued by the root
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: sans.map((value) => ({ type: 2, value })) },
  ]);
  cert.sign(caKey, forge.md.sha256.create()); // signed by the root key
  return {
    leafCertPem: forge.pki.certificateToPem(cert),
    leafKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** True when both PEMs parse and the private key matches the certificate. */
export function validateCaPair(certPem: string, keyPem: string): boolean {
  try {
    const cert = new X509Certificate(certPem);
    return cert.checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

/** True when `leafPem`'s signature verifies against `caPem`'s public key. */
export function isSignedBy(leafPem: string, caPem: string): boolean {
  try {
    const leaf = new X509Certificate(leafPem);
    const ca = new X509Certificate(caPem);
    return leaf.verify(ca.publicKey);
  } catch {
    return false;
  }
}

/** DNS SANs on a certificate, e.g. ['api.anthropic.com']. */
export function certSans(certPem: string): string[] {
  try {
    const san = new X509Certificate(certPem).subjectAltName ?? '';
    return san
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('DNS:'))
      .map((s) => s.slice('DNS:'.length));
  } catch {
    return [];
  }
}
