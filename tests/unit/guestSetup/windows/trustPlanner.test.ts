import { describe, expect, it } from 'vitest';
import {
  planTrustReconciliation,
  type ManagedTrustState,
  type PlanOperation,
  type TrustPlan,
  type TrustSnapshot,
} from '../../../../src/guestSetup/windows/trustPlanner';
import { makeCertificate } from './testCerts';

const ambientA = makeCertificate('ambient-a');
const ambientB = makeCertificate('ambient-b');
const ambientC = makeCertificate('ambient-c');
const proxyOld = makeCertificate('proxy-old');
const proxyNew = makeCertificate('proxy-new');

const ambientFile = (cert: { sha256: string; pem: string }) => ({
  fileName: `ambient-${cert.sha256}.pem`,
  text: cert.pem,
});
/** A manifest as a previous run of setup published it. `proxyOwned`: that run installed the proxy CA itself. */
const manifestText = (ambient: string[], proxy: string | null, proxyOwned = true): string =>
  JSON.stringify({ version: 1, ambient, proxy, proxyOwned });

const noManagedState: ManagedTrustState = {
  manifestText: null,
  proxyFileText: null,
  ambientFiles: [],
};

function snapshot(overrides: Partial<TrustSnapshot> = {}): TrustSnapshot {
  return {
    hostRoots: [ambientA, ambientB],
    proxy: proxyNew,
    guestRootSha256: [],
    managed: noManagedState,
    ...overrides,
  };
}

function expectOk(plan: TrustPlan): PlanOperation[] {
  if (!plan.ok) throw new Error(`expected a plan, got ${JSON.stringify(plan.failure)}`);
  return plan.operations;
}

const kinds = (operations: PlanOperation[]): string[] => operations.map((op) => op.kind);

function find<K extends PlanOperation['kind']>(
  operations: PlanOperation[],
  kind: K,
): Extract<PlanOperation, { kind: K }> {
  const found = operations.find((op) => op.kind === kind);
  if (!found) throw new Error(`no ${kind} operation in ${kinds(operations).join(', ')}`);
  return found as Extract<PlanOperation, { kind: K }>;
}

/** The base64 body line of a certificate's PEM, a stable marker for "this certificate is in the bundle". */
const bodyMarker = (cert: { pem: string }): string => cert.pem.split(/\r?\n/)[1];

const sorted = (...shas: string[]): string[] => [...shas].sort();

describe('planTrustReconciliation', () => {
  it('plans a first run: write ambient PEMs, import everything, verify, publish, set the environment', () => {
    const operations = expectOk(planTrustReconciliation(snapshot()));
    expect(kinds(operations)).toEqual([
      'write-ambient-pems',
      'import-ambient',
      'import-proxy',
      'verify-store',
      'publish',
      'set-environment',
    ]);
    expect(find(operations, 'write-ambient-pems').roots.map((r) => r.sha256)).toEqual(
      sorted(ambientA.sha256, ambientB.sha256),
    );
    expect(find(operations, 'import-proxy').root.sha256).toBe(proxyNew.sha256);
    const publish = find(operations, 'publish');
    expect(publish.manifest).toEqual({
      version: 1,
      ambient: sorted(ambientA.sha256, ambientB.sha256),
      proxy: proxyNew.sha256,
      proxyOwned: true,
    });
    expect(publish.bundlePem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(3);
    expect(find(operations, 'verify-store')).toEqual({
      kind: 'verify-store',
      present: sorted(ambientA.sha256, ambientB.sha256, proxyNew.sha256),
      absent: [],
    });
    expect(find(operations, 'set-environment').expectedBundle).toEqual(
      sorted(ambientA.sha256, ambientB.sha256, proxyNew.sha256),
    );
  });

  it('plans a replay with no change as verification and republication only', () => {
    const operations = expectOk(
      planTrustReconciliation(
        snapshot({
          guestRootSha256: [ambientA.sha256, ambientB.sha256, proxyNew.sha256],
          managed: {
            manifestText: manifestText(sorted(ambientA.sha256, ambientB.sha256), proxyNew.sha256),
            proxyFileText: proxyNew.pem,
            ambientFiles: [ambientFile(ambientA), ambientFile(ambientB)],
          },
        }),
      ),
    );
    expect(kinds(operations)).toEqual(['verify-store', 'publish', 'set-environment']);
  });

  it('imports and records only a newly selected ambient root on a later run', () => {
    const operations = expectOk(
      planTrustReconciliation(
        snapshot({
          hostRoots: [ambientA, ambientB, ambientC],
          guestRootSha256: [ambientA.sha256, ambientB.sha256, proxyNew.sha256],
          managed: {
            manifestText: manifestText(sorted(ambientA.sha256, ambientB.sha256), proxyNew.sha256),
            proxyFileText: proxyNew.pem,
            ambientFiles: [ambientFile(ambientA), ambientFile(ambientB)],
          },
        }),
      ),
    );
    expect(kinds(operations)).toEqual([
      'write-ambient-pems',
      'import-ambient',
      'verify-store',
      'publish',
      'set-environment',
    ]);
    expect(find(operations, 'write-ambient-pems').roots.map((r) => r.sha256)).toEqual([
      ambientC.sha256,
    ]);
    expect(find(operations, 'import-ambient').roots.map((r) => r.sha256)).toEqual([
      ambientC.sha256,
    ]);
    expect(find(operations, 'publish').manifest.ambient).toEqual(
      sorted(ambientA.sha256, ambientB.sha256, ambientC.sha256),
    );
  });

  it('retains an ambient root the host no longer selects: never removed, still in the bundle', () => {
    const operations = expectOk(
      planTrustReconciliation(
        snapshot({
          hostRoots: [ambientA],
          guestRootSha256: [ambientA.sha256, ambientB.sha256, proxyNew.sha256],
          managed: {
            manifestText: manifestText(sorted(ambientA.sha256, ambientB.sha256), proxyNew.sha256),
            proxyFileText: proxyNew.pem,
            ambientFiles: [ambientFile(ambientA), ambientFile(ambientB)],
          },
        }),
      ),
    );
    expect(kinds(operations)).not.toContain('remove-proxy');
    expect(find(operations, 'publish').manifest.ambient).toContain(ambientB.sha256);
    expect(find(operations, 'publish').bundlePem).toContain(bodyMarker(ambientB));
    expect(find(operations, 'verify-store').present).toContain(ambientB.sha256);
  });

  it('restores a retained ambient root that is missing from the guest store from its managed PEM', () => {
    const operations = expectOk(
      planTrustReconciliation(
        snapshot({
          hostRoots: [ambientA],
          guestRootSha256: [ambientA.sha256, proxyNew.sha256],
          managed: {
            manifestText: manifestText(sorted(ambientA.sha256, ambientB.sha256), proxyNew.sha256),
            proxyFileText: proxyNew.pem,
            ambientFiles: [ambientFile(ambientA), ambientFile(ambientB)],
          },
        }),
      ),
    );
    expect(find(operations, 'import-ambient').roots.map((r) => r.sha256)).toEqual([
      ambientB.sha256,
    ]);
  });

  it('rotates the proxy CA: install the new one, publish, and only then remove the old one', () => {
    const operations = expectOk(
      planTrustReconciliation(
        snapshot({
          hostRoots: [ambientA],
          guestRootSha256: [ambientA.sha256, proxyOld.sha256],
          managed: {
            manifestText: manifestText([ambientA.sha256], proxyOld.sha256),
            proxyFileText: proxyOld.pem,
            ambientFiles: [ambientFile(ambientA)],
          },
        }),
      ),
    );
    expect(kinds(operations)).toEqual([
      'import-proxy',
      'verify-store',
      'publish',
      'set-environment',
      'remove-proxy',
      'verify-store',
    ]);
    expect(find(operations, 'remove-proxy').sha256).toBe(proxyOld.sha256);
    const publish = find(operations, 'publish');
    expect(publish.manifest.proxy).toBe(proxyNew.sha256);
    expect(publish.bundlePem).not.toContain(bodyMarker(proxyOld));
    expect(operations.filter((op) => op.kind === 'verify-store').at(-1)).toEqual({
      kind: 'verify-store',
      present: sorted(ambientA.sha256, proxyNew.sha256),
      absent: [proxyOld.sha256],
    });
  });

  it('converges after an interrupted rotation: new PEM already written, manifest still names the old CA', () => {
    const operations = expectOk(
      planTrustReconciliation(
        snapshot({
          hostRoots: [ambientA],
          guestRootSha256: [ambientA.sha256, proxyOld.sha256, proxyNew.sha256],
          managed: {
            manifestText: manifestText([ambientA.sha256], proxyOld.sha256),
            proxyFileText: proxyNew.pem,
            ambientFiles: [ambientFile(ambientA)],
          },
        }),
      ),
    );
    expect(find(operations, 'remove-proxy').sha256).toBe(proxyOld.sha256);
    expect(kinds(operations)).not.toContain('import-proxy');
  });

  it('fails on ambiguous proxy ownership without planning any removal', () => {
    const plan = planTrustReconciliation(
      snapshot({
        hostRoots: [ambientA],
        guestRootSha256: [ambientA.sha256, proxyOld.sha256, ambientC.sha256],
        managed: {
          manifestText: manifestText([ambientA.sha256], proxyOld.sha256),
          // the proxy PEM on disk is a third certificate: the manifest and the file disagree
          proxyFileText: ambientC.pem,
          ambientFiles: [ambientFile(ambientA)],
        },
      }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure).toMatchObject({
      reason: 'ownership-ambiguity',
      operation: 'proxy cleanup',
      category: 'proxy',
    });
    expect(plan).not.toHaveProperty('operations');
  });

  describe('proxy CA ownership', () => {
    /** The manifest a run published, as the next run reads it from the guest. */
    const publishedManifest = (operations: PlanOperation[]): string =>
      JSON.stringify(find(operations, 'publish').manifest);

    it('does not record a proxy CA it found already installed as owned by setup', () => {
      // The old configure-network installed the CA; setup only finds it there.
      const operations = expectOk(
        planTrustReconciliation(
          snapshot({ proxy: proxyOld, hostRoots: [], guestRootSha256: [proxyOld.sha256] }),
        ),
      );
      expect(kinds(operations)).not.toContain('import-proxy');
      expect(find(operations, 'publish').manifest).toMatchObject({
        proxy: proxyOld.sha256,
        proxyOwned: false,
      });
    });

    it('does not delete a pre-existing proxy CA when the environment later rotates', () => {
      const firstRun = expectOk(
        planTrustReconciliation(
          snapshot({ proxy: proxyOld, hostRoots: [], guestRootSha256: [proxyOld.sha256] }),
        ),
      );
      const rotation = expectOk(
        planTrustReconciliation(
          snapshot({
            proxy: proxyNew,
            hostRoots: [],
            guestRootSha256: [proxyOld.sha256],
            managed: {
              manifestText: publishedManifest(firstRun),
              proxyFileText: proxyOld.pem,
              ambientFiles: [],
            },
          }),
        ),
      );
      expect(kinds(rotation)).toContain('import-proxy');
      expect(kinds(rotation)).not.toContain('remove-proxy');
      expect(find(rotation, 'verify-store').absent).toEqual([]);
      expect(find(rotation, 'publish').manifest).toMatchObject({
        proxy: proxyNew.sha256,
        proxyOwned: true,
      });
    });

    it('does delete a proxy CA that setup itself installed when the environment rotates', () => {
      const firstRun = expectOk(
        planTrustReconciliation(snapshot({ proxy: proxyOld, hostRoots: [], guestRootSha256: [] })),
      );
      expect(kinds(firstRun)).toContain('import-proxy');
      const rotation = expectOk(
        planTrustReconciliation(
          snapshot({
            proxy: proxyNew,
            hostRoots: [],
            guestRootSha256: [proxyOld.sha256],
            managed: {
              manifestText: publishedManifest(firstRun),
              proxyFileText: proxyOld.pem,
              ambientFiles: [],
            },
          }),
        ),
      );
      expect(find(rotation, 'remove-proxy').sha256).toBe(proxyOld.sha256);
    });

    it('keeps the ownership proven by an earlier run when it replays with the same proxy CA', () => {
      const replay = expectOk(
        planTrustReconciliation(
          snapshot({
            proxy: proxyOld,
            hostRoots: [],
            guestRootSha256: [proxyOld.sha256],
            managed: {
              manifestText: manifestText([], proxyOld.sha256, true),
              proxyFileText: proxyOld.pem,
              ambientFiles: [],
            },
          }),
        ),
      );
      expect(find(replay, 'publish').manifest.proxyOwned).toBe(true);
    });

    it('never removes a proxy CA when the manifest that could prove ownership is missing', () => {
      const operations = expectOk(
        planTrustReconciliation(
          snapshot({
            proxy: proxyNew,
            hostRoots: [],
            guestRootSha256: [proxyOld.sha256],
            managed: { manifestText: null, proxyFileText: proxyOld.pem, ambientFiles: [] },
          }),
        ),
      );
      expect(kinds(operations)).not.toContain('remove-proxy');
    });

    it('treats a manifest that never recorded ownership as not proving it', () => {
      const legacy = JSON.stringify({ version: 1, ambient: [], proxy: proxyOld.sha256 });
      const operations = expectOk(
        planTrustReconciliation(
          snapshot({
            proxy: proxyNew,
            hostRoots: [],
            guestRootSha256: [proxyOld.sha256],
            managed: { manifestText: legacy, proxyFileText: proxyOld.pem, ambientFiles: [] },
          }),
        ),
      );
      expect(kinds(operations)).not.toContain('remove-proxy');
    });

    it('does not claim ownership of a new proxy CA that was already installed when a rotation resumes', () => {
      // An interrupted rotation: the new PEM is on disk, both CAs are installed, the manifest is old.
      const operations = expectOk(
        planTrustReconciliation(
          snapshot({
            proxy: proxyNew,
            hostRoots: [],
            guestRootSha256: [proxyOld.sha256, proxyNew.sha256],
            managed: {
              manifestText: manifestText([], proxyOld.sha256, true),
              proxyFileText: proxyNew.pem,
              ambientFiles: [],
            },
          }),
        ),
      );
      expect(find(operations, 'remove-proxy').sha256).toBe(proxyOld.sha256);
      expect(find(operations, 'publish').manifest.proxyOwned).toBe(false);
    });
  });

  it('deduplicates a proxy CA that is also an ambient root, and never removes it on rotation', () => {
    const first = expectOk(planTrustReconciliation(snapshot({ hostRoots: [ambientA, proxyNew] })));
    expect(find(first, 'import-ambient').roots.map((r) => r.sha256)).toContain(proxyNew.sha256);
    expect(kinds(first)).not.toContain('import-proxy');
    const publish = find(first, 'publish');
    expect(publish.bundlePem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
    expect(publish.manifest.proxy).toBe(proxyNew.sha256);
    expect(publish.manifest.proxyOwned).toBe(false); // it is retained as an ambient root instead

    // Later the environment rotates to another CA; the old one stays because it is ambient too.
    const rotated = expectOk(
      planTrustReconciliation(
        snapshot({
          hostRoots: [ambientA, proxyNew],
          proxy: proxyOld,
          guestRootSha256: [ambientA.sha256, proxyNew.sha256, proxyOld.sha256],
          managed: {
            manifestText: manifestText(sorted(ambientA.sha256, proxyNew.sha256), proxyNew.sha256),
            proxyFileText: proxyNew.pem,
            ambientFiles: [ambientFile(ambientA), ambientFile(proxyNew)],
          },
        }),
      ),
    );
    expect(kinds(rotated)).not.toContain('remove-proxy');
  });

  it('rebuilds missing managed state from valid PEMs and keeps what those PEMs prove', () => {
    const operations = expectOk(
      planTrustReconciliation(
        snapshot({
          hostRoots: [ambientA],
          guestRootSha256: [ambientA.sha256, ambientB.sha256, proxyNew.sha256],
          managed: {
            manifestText: null,
            proxyFileText: proxyNew.pem,
            ambientFiles: [ambientFile(ambientA), ambientFile(ambientB)],
          },
        }),
      ),
    );
    expect(kinds(operations)).toEqual(['verify-store', 'publish', 'set-environment']);
    // ambientB is recovered from its PEM although the host no longer selects it
    expect(find(operations, 'publish').manifest.ambient).toEqual(
      sorted(ambientA.sha256, ambientB.sha256),
    );
  });

  it('does not remove a certificate it cannot prove it owns when managed state is missing', () => {
    // Nothing managed on disk, an unrelated old CA in the store: it is left alone.
    const operations = expectOk(
      planTrustReconciliation(snapshot({ guestRootSha256: [proxyOld.sha256] })),
    );
    expect(kinds(operations)).not.toContain('remove-proxy');
  });

  it('fails on a malformed ambient PEM instead of discarding it', () => {
    const plan = planTrustReconciliation(
      snapshot({
        managed: {
          manifestText: null,
          proxyFileText: null,
          ambientFiles: [{ fileName: `ambient-${ambientC.sha256}.pem`, text: 'not a certificate' }],
        },
      }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure).toMatchObject({
      reason: 'malformed-pem',
      operation: 'guest fingerprint',
      category: 'ambient',
      fingerprint: ambientC.sha256,
    });
  });

  it('fails on an ambient PEM whose content does not match its fingerprint name', () => {
    const plan = planTrustReconciliation(
      snapshot({
        managed: {
          manifestText: null,
          proxyFileText: null,
          ambientFiles: [{ fileName: `ambient-${ambientC.sha256}.pem`, text: ambientA.pem }],
        },
      }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure.reason).toBe('malformed-pem');
  });

  it('fails on a malformed proxy PEM', () => {
    const plan = planTrustReconciliation(
      snapshot({ managed: { ...noManagedState, proxyFileText: 'garbage' } }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure).toMatchObject({ reason: 'malformed-pem', category: 'proxy' });
  });

  it('fails on a malformed manifest rather than guessing ownership', () => {
    const plan = planTrustReconciliation(
      snapshot({ managed: { ...noManagedState, manifestText: '{not json' } }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure).toMatchObject({ reason: 'malformed-manifest', category: 'state' });
  });

  it('fails when the manifest retains an ambient root whose PEM is gone and the host no longer selects it', () => {
    const plan = planTrustReconciliation(
      snapshot({
        hostRoots: [ambientA],
        managed: {
          manifestText: manifestText(sorted(ambientA.sha256, ambientB.sha256), null),
          proxyFileText: null,
          ambientFiles: [ambientFile(ambientA)],
        },
      }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure).toMatchObject({
      reason: 'missing-pem',
      category: 'ambient',
      fingerprint: ambientB.sha256,
    });
  });

  it('diffs by lowercase DER SHA-256, so an uppercase guest fingerprint counts as present', () => {
    const operations = expectOk(
      planTrustReconciliation(
        snapshot({
          guestRootSha256: [
            ambientA.sha256.toUpperCase(),
            ambientB.sha256.toUpperCase(),
            proxyNew.sha256.toUpperCase(),
          ],
        }),
      ),
    );
    expect(kinds(operations)).not.toContain('import-ambient');
    expect(kinds(operations)).not.toContain('import-proxy');
  });
});
