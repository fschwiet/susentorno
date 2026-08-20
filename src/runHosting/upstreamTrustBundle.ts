import { createHash, X509Certificate } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import type { HostTrustedRoot } from '../guestSetup/hostTrustStore';

export class UpstreamTrustBundleError extends Error {}

export interface TrustBundleSources {
  /** PEMs from readPublicRootProgram(). */
  publicRoots: string[];
  /** Roots from enumerateHostTrustedRoots(). */
  hostRoots: HostTrustedRoot[];
  /** DER SHA-256 of every cert in the host's Disallowed stores. */
  disallowedSha256: string[];
  /** Test-only trust anchor, from --verify-upstream-overrides. */
  extraCaPem?: string;
}

export interface UpstreamTrustBundle {
  pem: string;
  publicRootCount: number;
  /** Host roots not already present in publicRoots. */
  ambientRootCount: number;
  /** Certificates excluded because their fingerprint is in disallowedSha256. */
  disallowedCount: number;
  /** Individually unparseable enumerated PEMs, dropped rather than fatal. */
  skippedCount: number;
  totalCount: number;
}

/**
 * Node's bundled Mozilla NSS root store. Chosen over the Windows Root store
 * because that store is lazily populated through CTL auto-update — measured at
 * 58 roots on a real host against Node's 118 — and Envoy cannot trigger the
 * fetch, so a Windows-only bundle would fail to validate origins whose root the
 * host has not cached yet.
 */
export function readPublicRootProgram(): string[] {
  return [...rootCertificates];
}

/** SHA-256 over DER, the same key hostTrustStore.ts computes. null when the PEM will not parse. */
function fingerprint(pem: string): string | null {
  try {
    return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
  } catch {
    return null;
  }
}

function normalizePem(pem: string): string {
  return `${pem.trimEnd()}\n`;
}

/**
 * Strict, unlike the skip rule applied to enumerated roots. This value exists
 * precisely to make one specific anchor trusted, so dropping it silently would
 * leave a valid-looking bundle while whatever depends on that anchor fails far
 * from the cause.
 */
export function parseExtraCaPem(pem: string): string {
  if (fingerprint(pem) === null) {
    throw new UpstreamTrustBundleError(
      'upstreamTrustBundle: the supplied extra CA is not a parseable PEM certificate',
    );
  }
  return pem;
}

export function assembleUpstreamTrustBundle(sources: TrustBundleSources): UpstreamTrustBundle {
  const disallowed = new Set(sources.disallowedSha256.map((value) => value.toLowerCase()));
  const seen = new Set<string>();
  const blocks: string[] = [];
  let publicRootCount = 0;
  let ambientRootCount = 0;
  let disallowedCount = 0;
  let skippedCount = 0;

  const add = (pem: string, onCounted: () => void): void => {
    const fp = fingerprint(pem);
    if (fp === null) {
      skippedCount++;
      return;
    }
    if (disallowed.has(fp)) {
      disallowedCount++;
      return;
    }
    if (seen.has(fp)) return;
    seen.add(fp);
    blocks.push(normalizePem(pem));
    onCounted();
  };

  for (const pem of sources.publicRoots) add(pem, () => publicRootCount++);
  for (const root of sources.hostRoots) add(root.pem, () => ambientRootCount++);

  if (sources.extraCaPem !== undefined) {
    const extra = parseExtraCaPem(sources.extraCaPem);
    const fp = fingerprint(extra);
    if (fp !== null && !seen.has(fp)) {
      seen.add(fp);
      blocks.push(normalizePem(extra));
    }
  }

  if (blocks.length === 0) {
    throw new UpstreamTrustBundleError(
      'upstreamTrustBundle: the assembled bundle is empty — no usable certificate authorities',
    );
  }

  return {
    pem: blocks.join(''),
    publicRootCount,
    ambientRootCount,
    disallowedCount,
    skippedCount,
    totalCount: blocks.length,
  };
}

/**
 * The Node version is reported because the public root set is only as fresh as
 * the Node build; without it an operator has no way to see the age of the trust
 * they are running on.
 */
export function formatTrustBundleSummary(bundle: UpstreamTrustBundle): string {
  return (
    `upstream trust bundle: ${bundle.publicRootCount} public roots (node ${process.version}) + ` +
    `${bundle.ambientRootCount} ambient = ${bundle.totalCount} ` +
    `(${bundle.disallowedCount} disallowed, ${bundle.skippedCount} skipped)`
  );
}

export function writeUpstreamTrustBundle(path: string, bundle: UpstreamTrustBundle): void {
  try {
    writeFileSync(path, bundle.pem);
  } catch (err) {
    throw new UpstreamTrustBundleError(
      `upstreamTrustBundle: could not write ${path}: ${(err as Error).message}`,
    );
  }
}
