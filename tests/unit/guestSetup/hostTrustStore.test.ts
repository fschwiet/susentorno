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

  it('enumerates both LocalMachine and CurrentUser Root', () => {
    expect(command).toContain('Cert:\\LocalMachine\\Root');
    expect(command).toContain('Cert:\\CurrentUser\\Root');
  });

  it('excludes thumbprints from both Disallowed stores', () => {
    expect(command).toContain('Cert:\\LocalMachine\\Disallowed');
    expect(command).toContain('Cert:\\CurrentUser\\Disallowed');
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
  it('returns an empty array for empty stdout', () => {
    expect(parseTrustedRootsResult('')).toEqual([]);
    expect(parseTrustedRootsResult('   ')).toEqual([]);
  });

  it('parses a single object, deriving sha256 over the DER bytes and a valid PEM', () => {
    const base64 = fakeDerBase64('single-root');
    const stdout = JSON.stringify({ Thumbprint: 'ABC123', RawDataBase64: base64 });
    const [root] = parseTrustedRootsResult(stdout);
    expect(root.thumbprint).toBe('ABC123');
    expect(root.sha256).toBe(
      createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
    );
    expect(() => new X509Certificate(root.pem)).not.toThrow();
  });

  it('parses an array of objects', () => {
    const stdout = JSON.stringify([
      { Thumbprint: 'A', RawDataBase64: fakeDerBase64('root-a') },
      { Thumbprint: 'B', RawDataBase64: fakeDerBase64('root-b') },
    ]);
    expect(parseTrustedRootsResult(stdout)).toHaveLength(2);
  });

  it('skips entries missing a thumbprint or raw data rather than throwing', () => {
    const stdout = JSON.stringify([
      { Thumbprint: 'A' },
      { RawDataBase64: fakeDerBase64('no-thumbprint') },
      { Thumbprint: 'C', RawDataBase64: fakeDerBase64('root-c') },
    ]);
    expect(parseTrustedRootsResult(stdout)).toHaveLength(1);
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

  it('dedupes across LocalMachine and CurrentUser before returning', async () => {
    const base64 = fakeDerBase64('dup-root');
    const stdout = JSON.stringify([
      { Thumbprint: 'LM', RawDataBase64: base64 },
      { Thumbprint: 'CU', RawDataBase64: base64 },
    ]);
    const roots = await enumerateHostTrustedRoots(fakeExec({ exitCode: 0, stdout }));
    expect(roots).toHaveLength(1);
  });
});
