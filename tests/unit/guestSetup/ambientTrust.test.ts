import { describe, it, expect } from 'vitest';
import type { PowerShellExec, PowerShellExecResult } from '../../../src/guestSetup/powerShellExec';
import type {
  RemoteExecWithCapture,
  RemoteExecResult,
  RemoteExecCaptureResult,
} from '../../../src/guestSetup/remoteExec';
import type { HostTrustedRoot } from '../../../src/guestSetup/hostTrustStore';
import {
  AmbientTrustError,
  buildSetNodeExtraCaCertsCommand,
  buildListGuestFingerprintsCommand,
  parseGuestFingerprints,
  diffAmbientCandidates,
  ambientCaFileName,
  buildInstallAmbientCaCommand,
  propagateAmbientTrust,
} from '../../../src/guestSetup/ambientTrust';

describe('buildSetNodeExtraCaCertsCommand', () => {
  const command = buildSetNodeExtraCaCertsCommand();

  it('removes any existing NODE_EXTRA_CA_CERTS line before appending, so reruns do not duplicate it', () => {
    expect(command).toContain("sed -i '/^NODE_EXTRA_CA_CERTS=/d' /etc/environment");
  });

  it('points at the full system bundle, not a single-CA file', () => {
    expect(command).toContain('NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt');
    expect(command).toContain('/etc/environment');
  });
});

describe('buildListGuestFingerprintsCommand', () => {
  it('fingerprints DER bytes via openssl and sha256sum, not the PEM text', () => {
    const command = buildListGuestFingerprintsCommand();
    expect(command).toContain('openssl x509');
    expect(command).toContain('-outform DER');
    expect(command).toContain('sha256sum');
  });
});

describe('parseGuestFingerprints', () => {
  it('lowercases and keeps only 64-hex-character lines', () => {
    const stdout = 'ABCDEF0123456789'.repeat(4) + '\n' + 'not-a-hash\n' + '';
    expect(parseGuestFingerprints(stdout)).toEqual(['abcdef0123456789'.repeat(4)]);
  });

  it('returns an empty array for empty stdout', () => {
    expect(parseGuestFingerprints('')).toEqual([]);
  });
});

describe('diffAmbientCandidates', () => {
  const known: HostTrustedRoot = { thumbprint: 'A', sha256: 'aaaa', pem: 'pem-a' };
  const unknown: HostTrustedRoot = { thumbprint: 'B', sha256: 'bbbb', pem: 'pem-b' };

  it('drops candidates whose sha256 the guest already has, case-insensitively', () => {
    expect(diffAmbientCandidates([known, unknown], ['AAAA'])).toEqual([unknown]);
  });

  it('returns everything when the guest has nothing matching', () => {
    expect(diffAmbientCandidates([known, unknown], [])).toEqual([known, unknown]);
  });
});

describe('ambientCaFileName', () => {
  it('derives a stable, filesystem-safe .crt name from the sha256', () => {
    const name = ambientCaFileName('abcdef0123456789' + 'a'.repeat(48));
    expect(name).toMatch(/^susentorno-ambient-[0-9a-f]+\.crt$/);
  });

  it('is deterministic for the same input', () => {
    expect(ambientCaFileName('same-hash')).toBe(ambientCaFileName('same-hash'));
  });
});

describe('buildInstallAmbientCaCommand', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  const command = buildInstallAmbientCaCommand('ambient.crt', pem);

  it('writes into the system trust anchor directory as base64, not raw PEM', () => {
    expect(command).toContain('sudo tee /usr/local/share/ca-certificates/ambient.crt');
    expect(command).toContain('base64 -d');
    expect(command).not.toContain('BEGIN CERTIFICATE');
  });
});

function fakePowerShellExec(result: PowerShellExecResult): PowerShellExec {
  return { run: async () => result };
}

function fakeRemoteExec(
  overrides: {
    runResult?: RemoteExecResult;
    captureResult?: RemoteExecCaptureResult;
  } = {},
): { remoteExec: RemoteExecWithCapture; runCalls: string[] } {
  const runCalls: string[] = [];
  return {
    runCalls,
    remoteExec: {
      async run(command: string): Promise<RemoteExecResult> {
        runCalls.push(command);
        return overrides.runResult ?? { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('propagateAmbientTrust should never call copyFile');
      },
      async capture(): Promise<RemoteExecCaptureResult> {
        return overrides.captureResult ?? { exitCode: 0, stdout: '' };
      },
    },
  };
}

describe('propagateAmbientTrust', () => {
  const hostRootJson = JSON.stringify({
    Thumbprint: 'T1',
    RawDataBase64: Buffer.from('fake-der-bytes').toString('base64'),
  });

  it('installs nothing and returns [] when the diff is empty', async () => {
    const { remoteExec, runCalls } = fakeRemoteExec({ captureResult: { exitCode: 0, stdout: '' } });
    // The guest already has the exact sha256 the host would report — force that
    // by using an exec whose enumeration returns nothing at all.
    const exec = fakePowerShellExec({ exitCode: 0, stdout: '' });
    const installed = await propagateAmbientTrust(exec, remoteExec);
    expect(installed).toEqual([]);
    expect(runCalls.some((c) => c.includes('update-ca-certificates'))).toBe(false);
  });

  it('sets NODE_EXTRA_CA_CERTS unconditionally, even with nothing to install', async () => {
    const { remoteExec, runCalls } = fakeRemoteExec();
    const exec = fakePowerShellExec({ exitCode: 0, stdout: '' });
    await propagateAmbientTrust(exec, remoteExec);
    expect(runCalls.some((c) => c.includes('NODE_EXTRA_CA_CERTS'))).toBe(true);
  });

  it('installs a host candidate the guest does not already trust, then runs update-ca-certificates once', async () => {
    const { remoteExec, runCalls } = fakeRemoteExec({ captureResult: { exitCode: 0, stdout: '' } });
    const exec = fakePowerShellExec({ exitCode: 0, stdout: hostRootJson });
    const installed = await propagateAmbientTrust(exec, remoteExec);
    expect(installed).toHaveLength(1);
    expect(runCalls.some((c) => c.includes('/usr/local/share/ca-certificates/'))).toBe(true);
    expect(runCalls.filter((c) => c === 'sudo update-ca-certificates')).toHaveLength(1);
  });

  it('throws AmbientTrustError when setting NODE_EXTRA_CA_CERTS fails', async () => {
    const { remoteExec } = fakeRemoteExec({ runResult: { exitCode: 1 } });
    const exec = fakePowerShellExec({ exitCode: 0, stdout: '' });
    await expect(propagateAmbientTrust(exec, remoteExec)).rejects.toThrow(AmbientTrustError);
  });

  it('throws AmbientTrustError when fingerprinting the guest fails', async () => {
    const { remoteExec } = fakeRemoteExec({ captureResult: { exitCode: 1, stdout: 'boom' } });
    const exec = fakePowerShellExec({ exitCode: 0, stdout: '' });
    await expect(propagateAmbientTrust(exec, remoteExec)).rejects.toThrow(AmbientTrustError);
  });

  it('reports steps via onStep in order, including the no-op message', async () => {
    const { remoteExec } = fakeRemoteExec({ captureResult: { exitCode: 0, stdout: '' } });
    const exec = fakePowerShellExec({ exitCode: 0, stdout: '' });
    const events: string[] = [];
    await propagateAmbientTrust(exec, remoteExec, (message) => events.push(message));
    expect(events.some((e) => e.includes('no ambient interception'))).toBe(true);
  });
});
