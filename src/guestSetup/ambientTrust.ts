import type { PowerShellExec } from './powerShellExec';
import type { RemoteExecWithCapture } from './remoteExec';
import { enumerateHostTrustedRoots, type HostTrustedRoot } from './hostTrustStore';

export class AmbientTrustError extends Error {}

const NODE_EXTRA_CA_CERTS_PATH = '/etc/ssl/certs/ca-certificates.crt';

/**
 * Removes any prior NODE_EXTRA_CA_CERTS line before appending the canonical
 * one, so a rerun leaves exactly one line rather than duplicating it —
 * propagateAmbientTrust runs this unconditionally on every invocation.
 */
export function buildSetNodeExtraCaCertsCommand(): string {
  return (
    "sudo sed -i '/^NODE_EXTRA_CA_CERTS=/d' /etc/environment && " +
    `printf 'NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS_PATH}\\n' | sudo tee -a /etc/environment >/dev/null`
  );
}

/**
 * Fingerprints DER bytes, not PEM text, for the same reason the host side
 * does: PEM formatting differences between Windows' export and Debian's own
 * per-cert files would otherwise show up as spurious "new" candidates. Walks
 * the individual *.pem symlinks update-ca-certificates maintains rather than
 * the combined ca-certificates.crt bundle, so this reports one fingerprint
 * per trusted cert rather than treating the whole bundle as one file.
 */
export function buildListGuestFingerprintsCommand(): string {
  return (
    'for f in /etc/ssl/certs/*.pem; do ' +
    'openssl x509 -in "$f" -outform DER 2>/dev/null | sha256sum | cut -d" " -f1; ' +
    'done'
  );
}

export function parseGuestFingerprints(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[0-9a-f]{64}$/.test(line));
}

export function diffAmbientCandidates(
  hostRoots: HostTrustedRoot[],
  guestFingerprints: string[],
): HostTrustedRoot[] {
  const known = new Set(guestFingerprints.map((f) => f.toLowerCase()));
  return hostRoots.filter((root) => !known.has(root.sha256.toLowerCase()));
}

export function ambientCaFileName(sha256: string): string {
  return `susentorno-ambient-${sha256.slice(0, 16)}.crt`;
}

/**
 * base64 over the wire: the PEM crosses bash -ic as one shell-quoted
 * argument, and its own newlines cannot survive that quoting reliably.
 */
export function buildInstallAmbientCaCommand(fileName: string, pem: string): string {
  const encoded = Buffer.from(pem, 'utf8').toString('base64');
  const destination = `/usr/local/share/ca-certificates/${fileName}`;
  return (
    `printf %s '${encoded}' | base64 -d | sudo tee ${destination} >/dev/null && ` +
    `sudo chmod 644 ${destination}`
  );
}

export async function propagateAmbientTrust(
  exec: PowerShellExec,
  remoteExec: RemoteExecWithCapture,
  onStep: (message: string) => void = () => {},
): Promise<string[]> {
  onStep('configure NODE_EXTRA_CA_CERTS');
  const envResult = await remoteExec.run(buildSetNodeExtraCaCertsCommand());
  if (envResult.exitCode !== 0) {
    throw new AmbientTrustError(
      `ambientTrust: could not set NODE_EXTRA_CA_CERTS (exit ${envResult.exitCode})`,
    );
  }

  onStep('enumerate host trusted roots');
  const hostRoots = await enumerateHostTrustedRoots(exec);

  onStep('fingerprint guest trust bundle');
  const fingerprintResult = await remoteExec.capture(buildListGuestFingerprintsCommand());
  if (fingerprintResult.exitCode !== 0) {
    throw new AmbientTrustError(
      `ambientTrust: could not fingerprint the guest trust bundle (exit ${fingerprintResult.exitCode}): ${fingerprintResult.stdout}`,
    );
  }
  const guestFingerprints = parseGuestFingerprints(fingerprintResult.stdout);

  const toInstall = diffAmbientCandidates(hostRoots, guestFingerprints);
  if (toInstall.length === 0) {
    onStep('no ambient interception detected');
    return [];
  }

  const installed: string[] = [];
  for (const root of toInstall) {
    const fileName = ambientCaFileName(root.sha256);
    const result = await remoteExec.run(buildInstallAmbientCaCommand(fileName, root.pem));
    if (result.exitCode !== 0) {
      throw new AmbientTrustError(
        `ambientTrust: could not install ${fileName} (exit ${result.exitCode})`,
      );
    }
    installed.push(fileName);
  }

  onStep(`trust ${installed.length} ambient CA(s): ${installed.join(', ')}`);
  const updateResult = await remoteExec.run('sudo update-ca-certificates');
  if (updateResult.exitCode !== 0) {
    throw new AmbientTrustError(
      `ambientTrust: update-ca-certificates failed (exit ${updateResult.exitCode})`,
    );
  }

  return installed;
}
