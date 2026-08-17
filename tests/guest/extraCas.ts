import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter } from 'node:path';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import { guestCapture } from './guestExec';

/**
 * Paths to extra CA certificates (PEM), separated by the platform path
 * delimiter, that each guest must trust.
 *
 * Set it when the machine running this tier sits behind a TLS-intercepting
 * proxy — a corporate middlebox, a CI runner behind inspection, or another
 * susentorno installation. The guest inherits the interception through the
 * host's NAT and DNS but inherits none of the trust that makes it workable, so
 * every host the interceptor terminates fails certificate verification inside
 * the guest while passed-through hosts keep working. That partial failure is
 * what makes it confusing to diagnose from inside a pre-script.
 *
 * Unset is the normal case and an exact no-op: a machine that is not
 * intercepted must see no behaviour change at all.
 *
 * This is the harness half of
 * docs/honist-v/briefs/2026-08-16-ambient-tls-trust-propagation-brief.md.
 * setup-guest-unix is not yet responsible for this; once it grows --extra-ca,
 * e2e.test.ts should pass the flag rather than staging beforehand, which is
 * what turns the flag into covered behaviour instead of merely present
 * behaviour.
 */
export const EXTRA_CA_ENV_VAR = 'SUSENTORNO_TEST_EXTRA_CA';

export function parseExtraCaPaths(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((path) => path.trim())
    .filter((path) => path !== '');
}

/** update-ca-certificates only reads files named *.crt, and only PEM inside them. */
export function extraCaFileName(localPath: string): string {
  const stem = basename(localPath).replace(/\.[^.]*$/, '');
  return `${stem.replace(/[^A-Za-z0-9._-]/g, '-')}.crt`;
}

/**
 * base64 over the wire rather than scp: the certificate crosses `bash -ic` as
 * one shell-quoted argument, and the base64 alphabet cannot terminate that
 * quoting the way a PEM's own newlines might. The autoinstall late-commands
 * seed files the same way.
 *
 * The system store only — deliberately no NODE_EXTRA_CA_CERTS. That variable
 * names a single file, so writing it here would race
 * nn-configure-network.sh:24, which points it at susentorno's own CA. Nothing
 * in the setup phase needs Node to trust the interceptor; curl and apt read the
 * system store. Reconciling the two belongs with the --extra-ca work.
 */
export function buildInstallExtraCaCommand(fileName: string, pem: string): string {
  const encoded = Buffer.from(pem, 'utf8').toString('base64');
  const destination = `/usr/local/share/ca-certificates/${fileName}`;
  return (
    `printf %s '${encoded}' | base64 -d | sudo tee ${destination} >/dev/null && ` +
    `sudo chmod 644 ${destination}`
  );
}

/** Install every CA named by EXTRA_CA_ENV_VAR into the guest's system store. */
export async function installExtraCas(target: SshTarget, label: string): Promise<string[]> {
  const paths = parseExtraCaPaths(process.env[EXTRA_CA_ENV_VAR]);
  if (paths.length === 0) return [];

  const installed: string[] = [];
  for (const path of paths) {
    // Loud rather than skipped: an unset variable means "not intercepted", but a
    // set variable naming a missing file means the operator meant to supply one.
    if (!existsSync(path)) {
      throw new Error(`${label}: ${EXTRA_CA_ENV_VAR} names a file that does not exist: ${path}`);
    }
    const fileName = extraCaFileName(path);
    const pem = readFileSync(path, 'utf8');
    const write = await guestCapture(target, buildInstallExtraCaCommand(fileName, pem));
    if (write.exitCode !== 0) {
      throw new Error(`${label}: could not write ${path} into the guest: ${write.stdout}`);
    }
    installed.push(fileName);
  }

  const update = await guestCapture(target, 'sudo update-ca-certificates');
  if (update.exitCode !== 0) {
    throw new Error(`${label}: update-ca-certificates failed: ${update.stdout}`);
  }
  console.log(`${label}: trusted ${installed.length} extra CA(s) — ${installed.join(', ')}`);
  return installed;
}
