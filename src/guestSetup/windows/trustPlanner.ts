import { X509Certificate, createHash } from 'node:crypto';
import { pemFromDer } from '../hostTrustStore';

/** The operations a reconciliation names in a failure. */
export type TrustOperationName =
  | 'host enumeration'
  | 'guest fingerprint'
  | 'ambient import'
  | 'proxy import'
  | 'bundle publication'
  | 'environment update'
  | 'proxy cleanup'
  | 'verification';

/** What kind of trust a failure concerns. `state` is the managed manifest itself. */
export type TrustCategory = 'ambient' | 'proxy' | 'bundle' | 'environment' | 'store' | 'state';

/** A certificate identified by the lowercase SHA-256 of its DER, with a canonical PEM. */
export interface TrustCertificate {
  sha256: string;
  pem: string;
}

export interface TrustManifest {
  version: 1;
  /** Lowercase DER SHA-256 of every managed ambient root, sorted. */
  ambient: string[];
  /** The current environment proxy CA, or null before one has been published. */
  proxy: string | null;
  /**
   * Whether setup itself installed `proxy` into the guest's root store. A CA that
   * was already there (for example from the old configure-network) is trusted but
   * not owned, so a later rotation must leave it in place. Ownership is only ever
   * recorded from an import this tool performed; a manifest that does not say
   * (an older one) proves nothing.
   */
  proxyOwned: boolean;
}

/** What the guest's managed trust directory held, exactly as read: unparsed text. */
export interface ManagedTrustState {
  manifestText: string | null;
  proxyFileText: string | null;
  ambientFiles: { fileName: string; text: string }[];
}

/** One immutable snapshot per run. */
export interface TrustSnapshot {
  /** Host roots selected by the production enumerator, deduplicated. */
  hostRoots: TrustCertificate[];
  /** The environment's validated `cert.pem`. */
  proxy: TrustCertificate;
  /** DER SHA-256 of the guest's `LocalMachine\Root`. */
  guestRootSha256: string[];
  managed: ManagedTrustState;
}

export type PlanOperation =
  | { kind: 'write-ambient-pems'; roots: TrustCertificate[] }
  | { kind: 'import-ambient'; roots: TrustCertificate[] }
  | { kind: 'import-proxy'; root: TrustCertificate }
  | { kind: 'verify-store'; present: string[]; absent: string[] }
  | { kind: 'publish'; manifest: TrustManifest; bundlePem: string; proxy: TrustCertificate }
  | { kind: 'set-environment'; expectedBundle: string[] }
  | { kind: 'remove-proxy'; sha256: string };

export type TrustPlanFailureReason =
  'ownership-ambiguity' | 'malformed-pem' | 'malformed-manifest' | 'missing-pem';

export interface TrustPlanFailure {
  reason: TrustPlanFailureReason;
  operation: TrustOperationName;
  category: TrustCategory;
  /** The full lowercase fingerprint when the failure concerns one certificate. */
  fingerprint?: string;
  /** Free of PEM content and subjects. */
  detail: string;
}

export type TrustPlan =
  { ok: true; operations: PlanOperation[] } | { ok: false; failure: TrustPlanFailure };

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const AMBIENT_FILE_PATTERN = /^ambient-([0-9a-fA-F]{64})\.pem$/;
const SINGLE_CERTIFICATE_PATTERN =
  /^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/;

/** Parses exactly one certificate from PEM text; undefined for anything else. */
export function parseCertificatePem(text: string): TrustCertificate | undefined {
  if (!SINGLE_CERTIFICATE_PATTERN.test(text)) return undefined;
  try {
    const raw = new X509Certificate(text).raw;
    return { sha256: createHash('sha256').update(raw).digest('hex'), pem: pemFromDer(raw) };
  } catch {
    return undefined;
  }
}

function parseManifest(text: string): TrustManifest | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown> | null;
    if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1) return undefined;
    const { ambient, proxy } = parsed;
    if (!Array.isArray(ambient) || !ambient.every((v) => typeof v === 'string')) return undefined;
    const lowered = (ambient as string[]).map((v) => v.toLowerCase());
    if (!lowered.every((v) => SHA256_PATTERN.test(v))) return undefined;
    if (
      proxy !== null &&
      (typeof proxy !== 'string' || !SHA256_PATTERN.test(proxy.toLowerCase()))
    ) {
      return undefined;
    }
    return {
      version: 1,
      ambient: lowered,
      proxy: proxy === null ? null : (proxy as string).toLowerCase(),
      proxyOwned: parsed.proxyOwned === true,
    };
  } catch {
    return undefined;
  }
}

const failed = (failure: TrustPlanFailure): TrustPlan => ({ ok: false, failure });

/**
 * Pure. From one snapshot (which carries the managed state as read from the
 * guest) returns the ordered operations that converge the guest, or a failure.
 *
 * Ambient trust is additive: whatever the manifest, a managed PEM, or the host
 * selection names stays retained. The proxy CA is replaceable: it is installed,
 * verified, and published before the previous one is removed, and the previous
 * one is removed only when managed state proves this tool installed it and no
 * ambient role keeps it. A proxy CA found already installed is never recorded as
 * owned, so it is never deleted. Nothing is planned for deletion on any failure.
 */
export function planTrustReconciliation(snapshot: TrustSnapshot): TrustPlan {
  const { managed, proxy } = snapshot;
  const guest = new Set(snapshot.guestRootSha256.map((sha) => sha.toLowerCase()));
  const selected = new Map(snapshot.hostRoots.map((root) => [root.sha256, root]));

  // Managed ambient PEMs: every one must be a single valid certificate named for its own fingerprint.
  const ambientFiles = new Map<string, TrustCertificate>();
  for (const file of managed.ambientFiles) {
    const nameSha = AMBIENT_FILE_PATTERN.exec(file.fileName)?.[1].toLowerCase();
    const cert = parseCertificatePem(file.text);
    if (!nameSha || !cert || cert.sha256 !== nameSha) {
      return failed({
        reason: 'malformed-pem',
        operation: 'guest fingerprint',
        category: 'ambient',
        fingerprint: nameSha,
        detail: 'a managed ambient PEM is malformed or does not match its fingerprint name',
      });
    }
    ambientFiles.set(cert.sha256, cert);
  }

  let proxyFile: TrustCertificate | undefined;
  if (managed.proxyFileText !== null) {
    proxyFile = parseCertificatePem(managed.proxyFileText);
    if (!proxyFile) {
      return failed({
        reason: 'malformed-pem',
        operation: 'guest fingerprint',
        category: 'proxy',
        detail: 'the managed proxy CA PEM is malformed',
      });
    }
  }

  let manifest: TrustManifest | undefined;
  if (managed.manifestText !== null) {
    manifest = parseManifest(managed.manifestText);
    if (!manifest) {
      return failed({
        reason: 'malformed-manifest',
        operation: 'guest fingerprint',
        category: 'state',
        detail:
          'the managed trust manifest is malformed, so ownership cannot be proven; ' +
          'delete it from the managed trust directory and rerun to rebuild it from the managed PEMs',
      });
    }
  }

  // Retained ambient roots: the manifest, the managed PEMs, and this run's host selection.
  const retainedShas = new Set<string>([...(manifest?.ambient ?? []), ...ambientFiles.keys()]);
  for (const sha of selected.keys()) retainedShas.add(sha);
  const retained: TrustCertificate[] = [];
  for (const sha of [...retainedShas].sort()) {
    const cert = selected.get(sha) ?? ambientFiles.get(sha);
    if (!cert) {
      return failed({
        reason: 'missing-pem',
        operation: 'guest fingerprint',
        category: 'ambient',
        fingerprint: sha,
        detail:
          'the manifest retains an ambient root whose managed PEM is missing and the host no longer selects it',
      });
    }
    retained.push(cert);
  }

  // The superseded proxy, and whether managed state proves setup installed it. Only a
  // manifest that recorded ownership proves it: a proxy PEM alone, or a manifest
  // that says nothing, shows setup handled the CA but not that it installed it.
  let previousProxy: string | null;
  let previousOwned: boolean;
  if (manifest) {
    const claimed = manifest.proxy;
    // A proxy PEM already written for this very rotation is an interrupted publication, not a disagreement.
    if (proxyFile && proxyFile.sha256 !== claimed && proxyFile.sha256 !== proxy.sha256) {
      return failed({
        reason: 'ownership-ambiguity',
        operation: 'proxy cleanup',
        category: 'proxy',
        fingerprint: claimed ?? proxyFile.sha256,
        detail:
          'the manifest and the managed proxy PEM disagree about which proxy CA setup installed',
      });
    }
    previousProxy = claimed;
    previousOwned = manifest.proxyOwned;
  } else {
    previousProxy = proxyFile?.sha256 ?? null;
    previousOwned = false;
  }
  const supersededProxy =
    previousOwned &&
    previousProxy !== null &&
    previousProxy !== proxy.sha256 &&
    !retainedShas.has(previousProxy) &&
    guest.has(previousProxy)
      ? previousProxy
      : undefined;

  const operations: PlanOperation[] = [];

  const toWrite = retained.filter(
    (cert) => selected.has(cert.sha256) && !ambientFiles.has(cert.sha256),
  );
  if (toWrite.length > 0) operations.push({ kind: 'write-ambient-pems', roots: toWrite });

  const toImport = retained.filter((cert) => !guest.has(cert.sha256));
  if (toImport.length > 0) operations.push({ kind: 'import-ambient', roots: toImport });

  // A proxy CA that is also retained ambient trust is imported (once) as an ambient root.
  const importsProxy = !guest.has(proxy.sha256) && !retainedShas.has(proxy.sha256);
  if (importsProxy) operations.push({ kind: 'import-proxy', root: proxy });
  // Setup owns the proxy CA only if it installs it now or an earlier run proved it did.
  const proxyOwned =
    importsProxy || (manifest?.proxy === proxy.sha256 && manifest.proxyOwned === true);

  const required = [...new Set([...retained.map((cert) => cert.sha256), proxy.sha256])].sort();
  operations.push({ kind: 'verify-store', present: required, absent: [] });

  const bundleCertificates = [...retained, ...(retainedShas.has(proxy.sha256) ? [] : [proxy])];
  operations.push({
    kind: 'publish',
    manifest: {
      version: 1,
      ambient: retained.map((cert) => cert.sha256),
      proxy: proxy.sha256,
      proxyOwned,
    },
    bundlePem: bundleCertificates.map((cert) => cert.pem).join(''),
    proxy,
  });
  operations.push({ kind: 'set-environment', expectedBundle: required });

  if (supersededProxy) {
    operations.push({ kind: 'remove-proxy', sha256: supersededProxy });
    operations.push({ kind: 'verify-store', present: required, absent: [supersededProxy] });
  }
  return { ok: true, operations };
}
