import { describe, it, expect } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import type { PowerShellExec, PowerShellExecResult } from '../../../src/guestSetup/powerShellExec';
import {
  buildEnumerateTrustedRootsCommand,
  parseTrustedRootsResult,
  dedupeBySha256,
  enumerateHostTrustedRoots,
  HostTrustStoreError,
  type HostTrustedRoot,
} from '../../../src/guestSetup/hostTrustStore';

describe('buildEnumerateTrustedRootsCommand', () => {
  const command = buildEnumerateTrustedRootsCommand();

  it('sets a terminating error preference', () => {
    expect(command).toContain("$ErrorActionPreference = 'Stop'");
  });

  it('enumerates both LocalMachine and CurrentUser Root via X509Store, not the Cert:\\ PSDrive', () => {
    expect(command).toContain('X509Store');
    expect(command).toContain("'Root'");
    expect(command).toContain("'LocalMachine','CurrentUser'");
    expect(command).not.toContain('Cert:\\');
  });

  it('excludes thumbprints from both Disallowed stores', () => {
    expect(command).toContain("'Disallowed'");
    expect(command).toContain('-notcontains $_.Thumbprint');
  });

  it('keeps certs unrestricted or explicitly allowing Server Authentication or anyExtendedKeyUsage', () => {
    expect(command).toContain('EnhancedKeyUsageList.Count -eq 0');
    expect(command).toContain('1.3.6.1.5.5.7.3.1'); // Server Authentication
    expect(command).toContain('2.5.29.37.0'); // anyExtendedKeyUsage
  });

  it('returns thumbprint and raw DER bytes as compressed JSON', () => {
    expect(command).toContain('Thumbprint');
    expect(command).toContain('RawDataBase64');
    expect(command).toContain('[Convert]::ToBase64String($_.RawData)');
    expect(command).toContain('ConvertTo-Json -Compress');
  });

  it('emits roots and the disallowed set as one JSON object', () => {
    expect(command).toContain('Roots = $keptRoots');
    expect(command).toContain('Disallowed = $disallowedOut');
    expect(command).toContain('ConvertTo-Json -Compress');
  });

  it('does not swallow a Disallowed enumeration failure', () => {
    expect(command).not.toContain('catch {}');
    expect(command).not.toContain('catch { }');
  });
});

/** A throwaway self-signed cert, purely to get real DER bytes to encode. */
function fakeDerBase64(commonName: string): string {
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
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

describe('parseTrustedRootsResult', () => {
  it('returns empty roots and no distrust for empty stdout', () => {
    expect(parseTrustedRootsResult('')).toEqual({ roots: [], disallowedSha256: [] });
    expect(parseTrustedRootsResult('   ')).toEqual({ roots: [], disallowedSha256: [] });
  });

  it('parses roots, deriving sha256 over the DER bytes and a valid PEM', () => {
    const base64 = fakeDerBase64('single-root');
    const stdout = JSON.stringify({
      Roots: [{ Thumbprint: 'ABC123', RawDataBase64: base64 }],
      Disallowed: [],
    });
    const { roots } = parseTrustedRootsResult(stdout);
    expect(roots).toHaveLength(1);
    expect(roots[0].thumbprint).toBe('ABC123');
    expect(roots[0].sha256).toBe(
      createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
    );
    expect(() => new X509Certificate(roots[0].pem)).not.toThrow();
  });

  it('returns the disallowed set as DER sha256 fingerprints', () => {
    const base64 = fakeDerBase64('distrusted-root');
    const stdout = JSON.stringify({
      Roots: [],
      Disallowed: [{ Thumbprint: 'BAD1', RawDataBase64: base64 }],
    });
    const { disallowedSha256 } = parseTrustedRootsResult(stdout);
    expect(disallowedSha256).toEqual([
      createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
    ]);
  });

  it('skips entries missing a thumbprint or raw data rather than throwing', () => {
    const stdout = JSON.stringify({
      Roots: [
        { Thumbprint: 'A' },
        { RawDataBase64: fakeDerBase64('no-thumbprint') },
        { Thumbprint: 'C', RawDataBase64: fakeDerBase64('root-c') },
      ],
      Disallowed: [],
    });
    expect(parseTrustedRootsResult(stdout).roots).toHaveLength(1);
  });

  it('tolerates the fields being absent entirely', () => {
    expect(parseTrustedRootsResult('{}')).toEqual({ roots: [], disallowedSha256: [] });
  });

  it('throws on unparseable JSON', () => {
    expect(() => parseTrustedRootsResult('not json')).toThrow();
  });
});

describe('dedupeBySha256', () => {
  it('keeps the first entry for a repeated sha256 and preserves single entries', () => {
    const a: HostTrustedRoot = { thumbprint: 'A', sha256: 'same', pem: 'pem-a' };
    const b: HostTrustedRoot = { thumbprint: 'B', sha256: 'same', pem: 'pem-b' };
    const c: HostTrustedRoot = { thumbprint: 'C', sha256: 'different', pem: 'pem-c' };
    expect(dedupeBySha256([a, b, c])).toEqual([a, c]);
  });
});

function fakeExec(result: PowerShellExecResult): PowerShellExec {
  return { run: async () => result };
}

describe('enumerateHostTrustedRoots', () => {
  it('throws HostTrustStoreError on a non-zero exit', async () => {
    await expect(
      enumerateHostTrustedRoots(fakeExec({ exitCode: 1, stdout: 'access denied' })),
    ).rejects.toThrow(HostTrustStoreError);
  });

  it('throws HostTrustStoreError on unparseable stdout rather than letting JSON.parse escape raw', async () => {
    await expect(
      enumerateHostTrustedRoots(fakeExec({ exitCode: 0, stdout: 'not json' })),
    ).rejects.toThrow(HostTrustStoreError);
  });

  it('dedupes roots across LocalMachine and CurrentUser before returning', async () => {
    const base64 = fakeDerBase64('dup-root');
    const stdout = JSON.stringify({
      Roots: [
        { Thumbprint: 'LM', RawDataBase64: base64 },
        { Thumbprint: 'CU', RawDataBase64: base64 },
      ],
      Disallowed: [],
    });
    const { roots } = await enumerateHostTrustedRoots(fakeExec({ exitCode: 0, stdout }));
    expect(roots).toHaveLength(1);
  });

  it('carries the disallowed fingerprints out alongside the roots', async () => {
    const badBase64 = fakeDerBase64('distrusted');
    const stdout = JSON.stringify({
      Roots: [{ Thumbprint: 'OK', RawDataBase64: fakeDerBase64('good') }],
      Disallowed: [{ Thumbprint: 'NO', RawDataBase64: badBase64 }],
    });
    const snapshot = await enumerateHostTrustedRoots(fakeExec({ exitCode: 0, stdout }));
    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.disallowedSha256).toEqual([
      createHash('sha256').update(Buffer.from(badBase64, 'base64')).digest('hex'),
    ]);
  });
});
