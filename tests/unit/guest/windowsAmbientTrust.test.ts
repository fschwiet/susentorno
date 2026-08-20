import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildImportRootScript,
  buildListGuestRootSha256Script,
  parseGuestRootSha256,
  propagateAmbientTrustToWindows,
} from '../../guest/windowsAmbientTrust';
import type { WindowsGuestExec } from '../../guest/windowsGuestExec';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';

describe('buildListGuestRootSha256Script', () => {
  it('reads LocalMachine\\Root via X509Store, not the Cert:\\ PSDrive', () => {
    const script = buildListGuestRootSha256Script();
    expect(script).toContain('X509Store');
    expect(script).toContain("'Root'");
    expect(script).toContain('LocalMachine');
    expect(script).not.toContain('Cert:\\');
  });

  it('reports SHA-256 over DER, matching the host-side diff key', () => {
    expect(buildListGuestRootSha256Script()).toContain('SHA256');
    expect(buildListGuestRootSha256Script()).toContain('RawData');
  });
});

describe('parseGuestRootSha256', () => {
  it('keeps only well-formed lowercase digests', () => {
    expect(parseGuestRootSha256(`${'A'.repeat(64)}\n  ${'b'.repeat(64)}  \nnope\n\n`)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
  });
});

describe('buildImportRootScript', () => {
  it('carries the PEM as base64 rather than as an embedded literal', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n';
    const script = buildImportRootScript(pem);
    expect(script).toContain(Buffer.from(pem, 'utf8').toString('base64'));
    expect(script).not.toContain('BEGIN CERTIFICATE');
    expect(script).toContain('X509Store');
  });
});

describe('propagateAmbientTrustToWindows', () => {
  const der = Buffer.from('fake-certificate');
  const sha256 = createHash('sha256').update(der).digest('hex');
  const hostStdout = JSON.stringify({
    Roots: [{ Thumbprint: 'AA', RawDataBase64: der.toString('base64') }],
    Disallowed: [],
  });

  it('imports only roots the guest is missing', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: hostStdout }) };
    const imported: string[] = [];
    const guest: WindowsGuestExec = {
      vmName: 'vm',
      run: async (script) => {
        imported.push(script);
        return { exitCode: 0, stdout: '' };
      },
      capture: async () => ({ exitCode: 0, stdout: '' }),
    };
    expect(await propagateAmbientTrustToWindows(exec, guest)).toHaveLength(1);
    expect(imported).toHaveLength(1);
  });

  it('imports nothing when the guest already trusts every host root', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: hostStdout }) };
    const guest: WindowsGuestExec = {
      vmName: 'vm',
      run: async () => {
        throw new Error('must not import anything');
      },
      capture: async () => ({ exitCode: 0, stdout: sha256 }),
    };
    expect(await propagateAmbientTrustToWindows(exec, guest)).toEqual([]);
  });
});
