import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLeaf } from '../../src/leaf';
import forge from 'node-forge';
import { generateRootCa, certSans, isSignedBy, namesIssuerByKey } from '../../src/ca';
import { envPaths, type EnvPaths } from '../../src/envPaths';

let dir: string;
let paths: EnvPaths;
let caCertPem: string;
let caKeyPem: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'leaf-test-'));
  paths = envPaths(dir);
  mkdirSync(paths.caDir, { recursive: true });
  const root = generateRootCa();
  caCertPem = root.caCertPem;
  caKeyPem = root.caKeyPem;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('leaf certificate issuance & reuse', () => {
  it('skips when there are no TLS-terminated hosts', () => {
    expect(ensureLeaf(paths, caCertPem, caKeyPem, [])).toContain('skipped leaf');
  });

  it('issues a leaf signed by the root with the requested SANs', () => {
    const status = ensureLeaf(paths, caCertPem, caKeyPem, ['api.anthropic.com']);
    expect(status).toContain('issued leaf for 1 host(s)');
    const leafPem = readFileSync(paths.caLeafCert, 'utf8');
    expect(isSignedBy(leafPem, caCertPem)).toBe(true);
    expect(certSans(leafPem)).toEqual(['api.anthropic.com']);
  });

  it('reuses a valid leaf when the SAN set is unchanged (order-insensitive)', () => {
    ensureLeaf(paths, caCertPem, caKeyPem, ['a.example.com', 'b.example.com']);
    const before = readFileSync(paths.caLeafCert, 'utf8');
    const status = ensureLeaf(paths, caCertPem, caKeyPem, ['b.example.com', 'a.example.com']);
    expect(status).toContain('reused leaf for 2 host(s)');
    expect(readFileSync(paths.caLeafCert, 'utf8')).toBe(before);
  });

  it('reissues when the SAN set changes', () => {
    ensureLeaf(paths, caCertPem, caKeyPem, ['a.example.com']);
    const status = ensureLeaf(paths, caCertPem, caKeyPem, ['a.example.com', 'new.example.com']);
    expect(status).toContain('issued leaf for 2 host(s)');
    expect(certSans(readFileSync(paths.caLeafCert, 'utf8')).sort()).toEqual([
      'a.example.com',
      'new.example.com',
    ]);
  });

  it('reissues a leaf that does not name its root by key', () => {
    // Leaves issued before leaves carried an authorityKeyIdentifier: still
    // signed by the root with the right SANs, but a verifier that also trusts
    // another root with the same name could pick the wrong issuer.
    const sans = ['a.example.com'];
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const caCert = forge.pki.certificateFromPem(caCertPem);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    cert.setSubject([{ name: 'commonName', value: 'old-style-leaf' }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: 'subjectAltName', altNames: sans.map((value) => ({ type: 2, value })) },
    ]);
    cert.sign(forge.pki.privateKeyFromPem(caKeyPem), forge.md.sha256.create());
    writeFileSync(paths.caLeafCert, forge.pki.certificateToPem(cert));
    writeFileSync(paths.caLeafKey, forge.pki.privateKeyToPem(keys.privateKey));
    expect(namesIssuerByKey(readFileSync(paths.caLeafCert, 'utf8'), caCertPem)).toBe(false);

    const status = ensureLeaf(paths, caCertPem, caKeyPem, sans);
    expect(status).toContain('issued leaf for 1 host(s)');
    expect(namesIssuerByKey(readFileSync(paths.caLeafCert, 'utf8'), caCertPem)).toBe(true);
  });
});
