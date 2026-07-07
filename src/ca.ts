import { X509Certificate, createPrivateKey } from 'node:crypto';
import selfsigned from 'selfsigned';

export const CA_COMMON_NAME = 'configamatron-proxy-certificate-authority';

/** Hostnames the proxy terminates TLS for; the cert must cover all of them. */
export const CA_SANS = [
  'api.anthropic.com',
  'claude.com',
  'platform.claude.com',
  'statsig.anthropic.com',
  'mcp-proxy.anthropic.com',
  'downloads.claude.ai',
];

export function generateCaPems(): { certPem: string; keyPem: string } {
  const pems = selfsigned.generate([{ name: 'commonName', value: CA_COMMON_NAME }], {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'subjectAltName',
        altNames: CA_SANS.map((value) => ({ type: 2, value })),
      },
    ],
  });
  return { certPem: pems.cert, keyPem: pems.private };
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
