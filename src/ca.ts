import { X509Certificate, createPrivateKey } from 'node:crypto';
import forge from 'node-forge';

/** Each root's CommonName is this prefix plus `-` and the start of its key identifier. */
export const CA_COMMON_NAME_PREFIX = 'susentorno-proxy-certificate-authority';
export const LEAF_COMMON_NAME = 'susentorno-proxy-leaf';

const VALIDITY_DAYS = 3650;

/** node-forge rarely emits a cert whose DER trips Node's strict X509 parser; regenerate on that. */
const MAX_GENERATION_ATTEMPTS = 5;

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
export function generateRootCa(): { caCertPem: string; caKeyPem: string; attempts: number } {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    const { notBefore, notAfter } = validityDates();
    cert.validity.notBefore = notBefore;
    cert.validity.notAfter = notAfter;
    // Each root gets its own name, suffixed with the start of its key
    // identifier. A guest can trust two susentorno roots at once (one copied
    // from the host's trust store as ambient trust, plus the environment's
    // own); with one fixed name, a verifier finding a leaf's issuer by name
    // could pick the wrong root and fail with "certificate signature failure".
    const keyId = rootKeyIdentifier(cert);
    const attrs = [{ name: 'commonName', value: `${CA_COMMON_NAME_PREFIX}-${keyId.slice(0, 8)}` }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs); // self-signed root
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const caCertPem = forge.pki.certificateToPem(cert);
    if (!isParseableCert(caCertPem)) continue;
    return {
      caCertPem,
      caKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
      attempts: attempt + 1,
    };
  }
  throw new Error(
    `generateRootCa: produced an unparseable certificate ${MAX_GENERATION_ATTEMPTS} times in a row`,
  );
}

/** Issue a leaf for `sans`, signed by the given root. */
export function generateLeaf(
  caCertPem: string,
  caKeyPem: string,
  sans: string[],
): { leafCertPem: string; leafKeyPem: string; attempts: number } {
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
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
      // Names the issuing root by key, not only by subject name, so a verifier
      // that also trusts another root with the same name (such as a root made
      // before roots had unique names) still picks this one.
      {
        name: 'authorityKeyIdentifier',
        keyIdentifier: forge.util.hexToBytes(rootKeyIdentifier(caCert)),
      },
    ]);
    cert.sign(caKey, forge.md.sha256.create()); // signed by the root key
    const leafCertPem = forge.pki.certificateToPem(cert);
    if (!isParseableCert(leafCertPem)) continue;
    return {
      leafCertPem,
      leafKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
      attempts: attempt + 1,
    };
  }
  throw new Error(
    `generateLeaf: produced an unparseable certificate ${MAX_GENERATION_ATTEMPTS} times in a row`,
  );
}

/**
 * The root's subject key identifier, as hex: the value of its own extension
 * when it has one, else the SHA-1 of its public key, which is what forge
 * writes for a new root's extension.
 */
function rootKeyIdentifier(caCert: forge.pki.Certificate): string {
  const extension = caCert.getExtension('subjectKeyIdentifier') as
    { subjectKeyIdentifier?: string } | undefined;
  return extension?.subjectKeyIdentifier ?? caCert.generateSubjectKeyIdentifier().toHex();
}

/**
 * True when `leafPem`'s authorityKeyIdentifier names `caPem`'s key, so a
 * verifier picks this root by key even if it trusts another root with the
 * same name. False for leaves issued before leaves carried one.
 */
export function namesIssuerByKey(leafPem: string, caPem: string): boolean {
  try {
    const extension = forge.pki
      .certificateFromPem(leafPem)
      .getExtension('authorityKeyIdentifier') as { value?: string } | undefined;
    if (!extension?.value) return false;
    // AuthorityKeyIdentifier ::= SEQUENCE { keyIdentifier [0] IMPLICIT OCTET STRING OPTIONAL, ... }
    const sequence = forge.asn1.fromDer(extension.value);
    const keyIdentifier = (sequence.value as forge.asn1.Asn1[]).find(
      (part) => part.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && part.type === 0,
    );
    if (!keyIdentifier || typeof keyIdentifier.value !== 'string') return false;
    const root = forge.pki.certificateFromPem(caPem);
    return forge.util.bytesToHex(keyIdentifier.value) === rootKeyIdentifier(root);
  } catch {
    return false;
  }
}

/** True when Node's strict X509 parser accepts the PEM (guards against rare malformed DER from node-forge). */
function isParseableCert(certPem: string): boolean {
  try {
    new X509Certificate(certPem);
    return true;
  } catch {
    return false;
  }
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
