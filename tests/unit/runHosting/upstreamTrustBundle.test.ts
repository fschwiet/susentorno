import { describe, it, expect } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { generateRootCa } from '../../../src/ca';
import type { HostTrustedRoot } from '../../../src/guestSetup/hostTrustStore';
import {
  assembleUpstreamTrustBundle,
  formatTrustBundleSummary,
  parseExtraCaPem,
  readPublicRootProgram,
  UpstreamTrustBundleError,
} from '../../../src/runHosting/upstreamTrustBundle';

/** A real, parseable self-signed cert — the assembler parses DER, so fakes will not do. */
function realPem(commonName: string): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

function sha256Of(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
}

function asHostRoot(pem: string): HostTrustedRoot {
  return { thumbprint: 'T', sha256: sha256Of(pem), pem };
}

const empty = { publicRoots: [], hostRoots: [], disallowedSha256: [] };

describe('readPublicRootProgram', () => {
  it('returns Node bundled roots, each of which parses as a certificate', () => {
    const roots = readPublicRootProgram();
    expect(roots.length).toBeGreaterThan(50);
    expect(() => new X509Certificate(roots[0])).not.toThrow();
  });
});

describe('assembleUpstreamTrustBundle', () => {
  it('counts a host root that is also a public root once, and not as ambient', () => {
    const shared = realPem('shared-root');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [shared],
      hostRoots: [asHostRoot(shared)],
    });
    expect(bundle.publicRootCount).toBe(1);
    expect(bundle.ambientRootCount).toBe(0);
    expect(bundle.totalCount).toBe(1);
    expect(bundle.pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
  });

  it('counts a host root absent from the public set as ambient and includes its PEM', () => {
    const publicRoot = realPem('public-root');
    const ambient = realPem('ambient-interceptor');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [publicRoot],
      hostRoots: [asHostRoot(ambient)],
    });
    expect(bundle.publicRootCount).toBe(1);
    expect(bundle.ambientRootCount).toBe(1);
    expect(bundle.pem).toContain(ambient.trimEnd());
  });

  it('excludes a PUBLIC root whose fingerprint is disallowed by the host', () => {
    const good = realPem('good-public');
    const distrusted = realPem('distrusted-public');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [good, distrusted],
      disallowedSha256: [sha256Of(distrusted)],
    });
    expect(bundle.publicRootCount).toBe(1);
    expect(bundle.disallowedCount).toBe(1);
    expect(bundle.pem).not.toContain(distrusted.trimEnd());
  });

  it('excludes a HOST root whose fingerprint is disallowed, without relying on hostTrustStore having filtered it', () => {
    const distrusted = realPem('distrusted-host');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [realPem('anchor')],
      hostRoots: [asHostRoot(distrusted)],
      disallowedSha256: [sha256Of(distrusted)],
    });
    expect(bundle.ambientRootCount).toBe(0);
    expect(bundle.disallowedCount).toBe(1);
  });

  it('matches disallowed fingerprints case-insensitively', () => {
    const distrusted = realPem('distrusted-upper');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [realPem('anchor'), distrusted],
      disallowedSha256: [sha256Of(distrusted).toUpperCase()],
    });
    expect(bundle.disallowedCount).toBe(1);
  });

  it('skips an unparseable enumerated PEM and keeps the rest', () => {
    const good = realPem('survivor');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [good, 'not a certificate at all'],
    });
    expect(bundle.publicRootCount).toBe(1);
    expect(bundle.skippedCount).toBe(1);
    expect(bundle.totalCount).toBe(1);
  });

  it('throws when the assembled bundle would be empty', () => {
    expect(() => assembleUpstreamTrustBundle({ ...empty })).toThrow(UpstreamTrustBundleError);
  });

  it('appends extraCaPem', () => {
    const extra = generateRootCa().caCertPem;
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [realPem('anchor')],
      extraCaPem: extra,
    });
    expect(bundle.totalCount).toBe(2);
    expect(bundle.pem).toContain(extra.trimEnd());
  });

  it('throws rather than silently skipping an unparseable extraCaPem', () => {
    expect(() =>
      assembleUpstreamTrustBundle({
        ...empty,
        publicRoots: [realPem('anchor')],
        extraCaPem: 'not a certificate at all',
      }),
    ).toThrow(UpstreamTrustBundleError);
  });

  it('emits concatenated PEM where every block is delimited and newline-terminated', () => {
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [realPem('a'), realPem('b')],
    });
    expect(bundle.pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
    expect(bundle.pem.match(/-----END CERTIFICATE-----/g)).toHaveLength(2);
    expect(bundle.pem.endsWith('\n')).toBe(true);
    expect(bundle.pem).not.toContain('-----END CERTIFICATE----------BEGIN CERTIFICATE-----');
  });
});

describe('parseExtraCaPem', () => {
  it('returns the PEM unchanged when it parses', () => {
    const pem = generateRootCa().caCertPem;
    expect(parseExtraCaPem(pem)).toBe(pem);
  });

  it('throws UpstreamTrustBundleError when it does not', () => {
    expect(() => parseExtraCaPem('nope')).toThrow(UpstreamTrustBundleError);
  });
});

describe('formatTrustBundleSummary', () => {
  it('reports the counts and the Node version', () => {
    const summary = formatTrustBundleSummary({
      pem: '',
      publicRootCount: 118,
      ambientRootCount: 3,
      disallowedCount: 0,
      skippedCount: 2,
      totalCount: 121,
    });
    expect(summary).toContain('118 public roots');
    expect(summary).toContain(process.version);
    expect(summary).toContain('3 ambient');
    expect(summary).toContain('121');
    expect(summary).toContain('0 disallowed');
    expect(summary).toContain('2 skipped');
  });
});
