import { enumerateHostTrustedRoots } from '../hostTrustStore';
import type { PowerShellExec } from '../powerShellExec';
import { WindowsGuestError, type WindowsGuestExecutor } from './guestExecutor';
import {
  parseCertificatePem,
  planTrustReconciliation,
  type ManagedTrustState,
  type PlanOperation,
  type TrustCategory,
  type TrustOperationName,
  type TrustSnapshot,
} from './trustPlanner';
import {
  buildImportScript,
  buildInspectScript,
  buildListRootsScript,
  buildPublishScript,
  buildRemoveProxyScript,
  buildSetEnvironmentScript,
  buildWriteAmbientPemsScript,
} from './trustScripts';

export {
  planTrustReconciliation,
  parseCertificatePem,
  type ManagedTrustState,
  type PlanOperation,
  type TrustCategory,
  type TrustOperationName,
  type TrustPlan,
  type TrustSnapshot,
} from './trustPlanner';
export {
  GUEST_TRUST_BUNDLE_FILE,
  GUEST_TRUST_BUNDLE_PATH,
  GUEST_TRUST_DIR,
  GUEST_TRUST_MANIFEST_FILE,
  GUEST_TRUST_PROXY_FILE,
} from './trustScripts';

/** Each trust invocation is bounded at 2 minutes. */
export const TRUST_INVOCATION_TIMEOUT_MS = 120_000;

const ABBREVIATED_FINGERPRINT_LENGTH = 12;
const MAX_DETAIL_LENGTH = 400;

const abbreviate = (fingerprint: string): string =>
  fingerprint.slice(0, ABBREVIATED_FINGERPRINT_LENGTH);

/**
 * The typed failure of a Windows guest trust reconciliation. It names the
 * operation, the trust category, and an abbreviated fingerprint, plus a bounded
 * and redacted detail. It never carries PEM content, certificate subjects, or
 * credentials.
 */
export class WindowsTrustReconciliationError extends Error {
  readonly operation: TrustOperationName;
  readonly category: TrustCategory;
  /** Abbreviated (first 12 hex characters). */
  readonly fingerprint?: string;

  constructor(
    operation: TrustOperationName,
    category: TrustCategory,
    detail: string,
    fingerprint?: string,
  ) {
    const abbreviated = fingerprint === undefined ? undefined : abbreviate(fingerprint);
    super(
      `Windows guest trust reconciliation failed during ${operation} ` +
        `(${category}${abbreviated ? `, ${abbreviated}` : ''}): ${redact(detail)}`,
    );
    this.name = 'WindowsTrustReconciliationError';
    this.operation = operation;
    this.category = category;
    this.fingerprint = abbreviated;
  }
}

/** Strips PEM blocks and long base64 runs, abbreviates full fingerprints, and bounds the length. */
export function redact(text: string): string {
  const cleaned = text
    .replace(
      /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g,
      '[certificate redacted]',
    )
    .replace(/\b[0-9a-fA-F]{64}\b/g, (fingerprint) => abbreviate(fingerprint.toLowerCase()))
    .replace(/[A-Za-z0-9+/=]{40,}/g, '[data redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_DETAIL_LENGTH
    ? `${cleaned.slice(0, MAX_DETAIL_LENGTH)}... [truncated]`
    : cleaned;
}

export interface ReconcileTrustOptions {
  /** Host PowerShell, for the production root enumerator. */
  hostExec: PowerShellExec;
  executor: Pick<WindowsGuestExecutor, 'vmName' | 'invoke'>;
  /** The environment's `cert.pem` as read on the host. */
  proxyCaPem: string;
  signal?: AbortSignal;
  /** Counts and abbreviated fingerprints only. */
  onProgress?: (line: string) => void;
}

export interface TrustReconcileResult {
  /** Managed ambient roots retained, including ones the host no longer selects. */
  ambientRetained: number;
  /** Certificates this run added to the guest's root store. */
  imported: number;
  /** Whether a superseded proxy CA was removed. */
  proxyReplaced: boolean;
  /** Abbreviated fingerprint of the current proxy CA. */
  proxyFingerprint: string;
}

interface GuestVerdict {
  Outcome?: unknown;
  Fingerprint?: unknown;
  Message?: unknown;
  [key: string]: unknown;
}

interface OperationIdentity {
  operation: TrustOperationName;
  category: TrustCategory;
}

const IDENTITY: Record<PlanOperation['kind'], OperationIdentity> = {
  'write-ambient-pems': { operation: 'ambient import', category: 'ambient' },
  'import-ambient': { operation: 'ambient import', category: 'ambient' },
  'import-proxy': { operation: 'proxy import', category: 'proxy' },
  'verify-store': { operation: 'verification', category: 'store' },
  publish: { operation: 'bundle publication', category: 'bundle' },
  'set-environment': { operation: 'environment update', category: 'environment' },
  'remove-proxy': { operation: 'proxy cleanup', category: 'proxy' },
};

const asStringList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).filter(
    (item): item is string => typeof item === 'string',
  );

function decodeBase64(value: unknown): string | null {
  return typeof value === 'string'
    ? Buffer.from(value, 'base64')
        .toString('utf8')
        .replace(/^\uFEFF/, '')
    : null;
}

/**
 * Host-driven Windows guest trust reconciliation, the only owner of certificate
 * imports, the managed trust files, and machine `NODE_EXTRA_CA_CERTS`.
 *
 * One snapshot is taken (the host's roots through the production enumerator,
 * the validated proxy CA, the guest's root fingerprints and managed state); the
 * pure planner turns it into operations; each runs as one executor invocation.
 * It stops at the first failure with no rollback: imports, valid managed PEMs,
 * and the previously published bundle are all safe residual state, and a replay
 * converges from any of them.
 */
export async function reconcileWindowsGuestTrust(
  options: ReconcileTrustOptions,
): Promise<TrustReconcileResult> {
  const { executor, signal } = options;
  const progress = (line: string): void => options.onProgress?.(line);

  const proxy = parseCertificatePem(options.proxyCaPem);
  if (!proxy) {
    throw new WindowsTrustReconciliationError(
      'host enumeration',
      'proxy',
      "the environment's cert.pem is not a single valid certificate; run 'susentorno generate-ca' and 'susentorno update-shares'",
    );
  }

  progress('enumerating the host trusted roots');
  let hostRoots;
  try {
    hostRoots = (await enumerateHostTrustedRoots(options.hostExec)).roots;
  } catch (error) {
    throw new WindowsTrustReconciliationError(
      'host enumeration',
      'ambient',
      error instanceof Error ? error.message : String(error),
    );
  }

  const invoke = async (
    identity: OperationIdentity,
    script: string,
    fingerprint?: string,
  ): Promise<GuestVerdict> => {
    let result;
    try {
      result = await executor.invoke(script, { timeoutMs: TRUST_INVOCATION_TIMEOUT_MS, signal });
    } catch (error) {
      if (error instanceof WindowsGuestError && error.kind !== 'cancelled') {
        throw new WindowsTrustReconciliationError(
          identity.operation,
          identity.category,
          error.message,
          fingerprint,
        );
      }
      throw error;
    }
    const fail = (detail: string, failingFingerprint = fingerprint) =>
      new WindowsTrustReconciliationError(
        identity.operation,
        identity.category,
        detail,
        failingFingerprint,
      );
    if (result.timedOut) {
      throw fail(`the guest did not finish within ${TRUST_INVOCATION_TIMEOUT_MS / 60_000} minutes`);
    }
    if (result.exitCode !== 0) {
      throw fail(
        `the guest script exited with ${result.exitCode}: ${result.stderr || result.stdout}`,
      );
    }
    let verdict: GuestVerdict;
    try {
      verdict = JSON.parse(result.stdout.trim()) as GuestVerdict;
    } catch {
      throw fail(`the guest returned output setup could not read: ${result.stdout}`);
    }
    if (verdict.Outcome !== 'ok') {
      throw fail(
        typeof verdict.Message === 'string' ? verdict.Message : 'the guest reported a failure',
        typeof verdict.Fingerprint === 'string' ? verdict.Fingerprint : fingerprint,
      );
    }
    return verdict;
  };

  progress(`fingerprinting the guest root store on '${executor.vmName}'`);
  const inspected = await invoke(
    { operation: 'guest fingerprint', category: 'store' },
    buildInspectScript(),
  );
  const managed: ManagedTrustState = {
    manifestText: decodeBase64(inspected.Manifest),
    proxyFileText: decodeBase64(inspected.ProxyFile),
    ambientFiles: (Array.isArray(inspected.Files) ? inspected.Files : [inspected.Files])
      .filter((file): file is { Name: string; Base64: string } => {
        const candidate = file as { Name?: unknown; Base64?: unknown } | null;
        return typeof candidate?.Name === 'string' && typeof candidate?.Base64 === 'string';
      })
      .map((file) => ({ fileName: file.Name, text: decodeBase64(file.Base64) ?? '' })),
  };
  const snapshot: TrustSnapshot = {
    hostRoots,
    proxy,
    guestRootSha256: asStringList(inspected.Roots),
    managed,
  };
  progress(
    `snapshot: ${hostRoots.length} host root(s) selected, ${snapshot.guestRootSha256.length} guest root(s), ` +
      `proxy CA ${abbreviate(proxy.sha256)}`,
  );

  const plan = planTrustReconciliation(snapshot);
  if (!plan.ok) {
    const { failure } = plan;
    throw new WindowsTrustReconciliationError(
      failure.operation,
      failure.category,
      failure.detail,
      failure.fingerprint,
    );
  }

  let imported = 0;
  let proxyReplaced = false;
  let ambientRetained = 0;
  for (const step of plan.operations) {
    const identity = IDENTITY[step.kind];
    switch (step.kind) {
      case 'write-ambient-pems':
        progress(`writing ${step.roots.length} managed ambient PEM(s)`);
        await invoke(identity, buildWriteAmbientPemsScript(step.roots));
        break;
      case 'import-ambient':
        progress(`importing ${step.roots.length} ambient root(s) into LocalMachine\\Root`);
        await invoke(identity, buildImportScript('import-ambient', step.roots));
        imported += step.roots.length;
        break;
      case 'import-proxy':
        progress(`importing proxy CA ${abbreviate(step.root.sha256)} into LocalMachine\\Root`);
        await invoke(identity, buildImportScript('import-proxy', [step.root]), step.root.sha256);
        imported += 1;
        break;
      case 'verify-store': {
        progress('re-reading the guest root store to verify');
        const verdict = await invoke(identity, buildListRootsScript());
        const present = new Set(asStringList(verdict.Roots).map((sha) => sha.toLowerCase()));
        const missing = step.present.filter((sha) => !present.has(sha));
        if (missing.length > 0) {
          throw new WindowsTrustReconciliationError(
            identity.operation,
            identity.category,
            `${missing.length} required certificate(s) are missing from the guest root store`,
            missing[0],
          );
        }
        const remaining = step.absent.filter((sha) => present.has(sha));
        if (remaining.length > 0) {
          throw new WindowsTrustReconciliationError(
            identity.operation,
            identity.category,
            `${remaining.length} certificate(s) that should have been removed remain in the guest root store`,
            remaining[0],
          );
        }
        break;
      }
      case 'publish':
        ambientRetained = step.manifest.ambient.length;
        progress(
          `publishing the manifest and one combined bundle (${new Set([...step.manifest.ambient, proxy.sha256]).size} certificate(s))`,
        );
        await invoke(identity, buildPublishScript(step));
        break;
      case 'set-environment':
        progress('setting and verifying machine NODE_EXTRA_CA_CERTS');
        await invoke(identity, buildSetEnvironmentScript(step.expectedBundle));
        break;
      case 'remove-proxy':
        progress(`removing the superseded proxy CA ${abbreviate(step.sha256)}`);
        await invoke(identity, buildRemoveProxyScript(step.sha256), step.sha256);
        proxyReplaced = true;
        break;
    }
  }

  progress(
    `trust reconciled: proxy CA ${abbreviate(proxy.sha256)}, ${imported} certificate(s) imported`,
  );
  return {
    ambientRetained,
    imported,
    proxyReplaced,
    proxyFingerprint: abbreviate(proxy.sha256),
  };
}
