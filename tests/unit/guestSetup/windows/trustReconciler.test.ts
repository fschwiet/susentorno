import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PowerShellExec } from '../../../../src/guestSetup/powerShellExec';
import {
  WindowsGuestError,
  type WindowsGuestExecutor,
  type WindowsGuestResult,
} from '../../../../src/guestSetup/windows/guestExecutor';
import {
  reconcileWindowsGuestTrust,
  WindowsTrustReconciliationError,
  TRUST_INVOCATION_TIMEOUT_MS,
} from '../../../../src/guestSetup/windows/trustReconciler';
import { makeCertificate } from './testCerts';

const ambientA = makeCertificate('applier-ambient-a');
const ambientB = makeCertificate('applier-ambient-b');
const proxyOld = makeCertificate('applier-proxy-old');
const proxyNew = makeCertificate('applier-proxy-new');

const der64 = (pem: string): string => new X509Certificate(pem).raw.toString('base64');
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const ok = (value: unknown): WindowsGuestResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: '',
  timedOut: false,
});

const hostExecFor = (roots: { pem: string }[], exitCode = 0, stdout?: string): PowerShellExec => ({
  async run() {
    return {
      exitCode,
      stdout:
        stdout ??
        JSON.stringify({
          Roots: roots.map((r) => ({ Thumbprint: 'AA', RawDataBase64: der64(r.pem) })),
          Disallowed: [],
        }),
    };
  },
});

const operationOf = (script: string): string =>
  /^# susentorno trust: ([\w-]+)/.exec(script)?.[1] ?? 'unknown';

/** Every sha256 the script names, in order of appearance. */
const shasIn = (script: string): string[] =>
  [...script.matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1]);

interface GuestState {
  roots: string[];
  manifestText: string | null;
  proxyFileText: string | null;
  ambientFiles: { fileName: string; text: string }[];
  /** Replace the answer to one operation outright. */
  override?: Partial<Record<string, WindowsGuestResult | Error>>;
}

function fakeGuest(state: GuestState) {
  const invoked: { operation: string; script: string; timeoutMs: number }[] = [];
  const executor: WindowsGuestExecutor = {
    vmName: 'win-dev',
    async invoke(script, options) {
      const operation = operationOf(script);
      invoked.push({ operation, script, timeoutMs: options.timeoutMs });
      const override = state.override?.[operation];
      if (override instanceof Error) throw override;
      if (override) return override;
      switch (operation) {
        case 'inspect':
          return ok({
            Outcome: 'ok',
            Roots: state.roots,
            Manifest: state.manifestText === null ? null : b64(state.manifestText),
            ProxyFile: state.proxyFileText === null ? null : b64(state.proxyFileText),
            Files: state.ambientFiles.map((f) => ({ Name: f.fileName, Base64: b64(f.text) })),
          });
        case 'roots':
          return ok({ Outcome: 'ok', Roots: state.roots });
        case 'import-ambient':
        case 'import-proxy':
          state.roots.push(...shasIn(script));
          return ok({ Outcome: 'ok' });
        case 'remove-proxy': {
          const [sha] = shasIn(script);
          state.roots = state.roots.filter((r) => r !== sha);
          return ok({ Outcome: 'ok' });
        }
        default:
          return ok({ Outcome: 'ok' });
      }
    },
    async drainCancelled() {},
    async dispose() {},
  };
  return { executor, invoked, state };
}

const freshGuest = (overrides: Partial<GuestState> = {}) =>
  fakeGuest({
    roots: [],
    manifestText: null,
    proxyFileText: null,
    ambientFiles: [],
    ...overrides,
  });

async function reconcile(
  guest: ReturnType<typeof fakeGuest>,
  options: {
    hostRoots?: { pem: string }[];
    proxyPem?: string;
    hostExec?: PowerShellExec;
    progress?: string[];
    signal?: AbortSignal;
  } = {},
) {
  return reconcileWindowsGuestTrust({
    hostExec: options.hostExec ?? hostExecFor(options.hostRoots ?? [ambientA, ambientB]),
    executor: guest.executor,
    proxyCaPem: options.proxyPem ?? proxyNew.pem,
    signal: options.signal,
    onProgress: (line) => options.progress?.push(line),
  });
}

async function failureOf(work: Promise<unknown>): Promise<WindowsTrustReconciliationError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof WindowsTrustReconciliationError) return error;
    throw error;
  }
  throw new Error('expected a WindowsTrustReconciliationError');
}

describe('reconcileWindowsGuestTrust', () => {
  it('runs a first reconciliation in the documented apply order and reports the outcome', async () => {
    const guest = freshGuest();
    const progress: string[] = [];
    const result = await reconcile(guest, { progress });
    expect(guest.invoked.map((i) => i.operation)).toEqual([
      'inspect',
      'write-ambient-pems',
      'import-ambient',
      'import-proxy',
      'roots',
      'publish',
      'set-environment',
    ]);
    expect(result).toMatchObject({ ambientRetained: 2, imported: 3, proxyReplaced: false });
    expect(result.proxyFingerprint).toBe(proxyNew.sha256.slice(0, 12));
    // every invocation is bounded at 2 minutes
    expect(guest.invoked.every((i) => i.timeoutMs === TRUST_INVOCATION_TIMEOUT_MS)).toBe(true);
    expect(TRUST_INVOCATION_TIMEOUT_MS).toBe(120_000);
  });

  it('imports into LocalMachine Root only, never Current User, and never with certutil', async () => {
    const guest = freshGuest();
    await reconcile(guest);
    const scripts = guest.invoked.map((i) => i.script).join('\n');
    expect(scripts).toContain('"LocalMachine"');
    expect(scripts).not.toMatch(/CurrentUser/);
    expect(scripts).not.toMatch(/certutil/i);
  });

  it('carries certificates as base64 and never as PEM text in a script', async () => {
    const guest = freshGuest();
    await reconcile(guest);
    for (const { script } of guest.invoked) {
      expect(script).not.toMatch(/-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/]{20}/);
    }
  });

  it('does nothing beyond verification and republication when nothing changed', async () => {
    const guest = freshGuest({
      roots: [ambientA.sha256, ambientB.sha256, proxyNew.sha256],
      manifestText: JSON.stringify({
        version: 1,
        ambient: [ambientA.sha256, ambientB.sha256].sort(),
        proxy: proxyNew.sha256,
      }),
      proxyFileText: proxyNew.pem,
      ambientFiles: [
        { fileName: `ambient-${ambientA.sha256}.pem`, text: ambientA.pem },
        { fileName: `ambient-${ambientB.sha256}.pem`, text: ambientB.pem },
      ],
    });
    const result = await reconcile(guest);
    expect(guest.invoked.map((i) => i.operation)).toEqual([
      'inspect',
      'roots',
      'publish',
      'set-environment',
    ]);
    expect(result.imported).toBe(0);
  });

  it('installs, verifies, and publishes the new proxy CA before removing the old one', async () => {
    const guest = freshGuest({
      roots: [ambientA.sha256, proxyOld.sha256],
      manifestText: JSON.stringify({
        version: 1,
        ambient: [ambientA.sha256],
        proxy: proxyOld.sha256,
      }),
      proxyFileText: proxyOld.pem,
      ambientFiles: [{ fileName: `ambient-${ambientA.sha256}.pem`, text: ambientA.pem }],
    });
    const result = await reconcile(guest, { hostRoots: [ambientA] });
    expect(guest.invoked.map((i) => i.operation)).toEqual([
      'inspect',
      'import-proxy',
      'roots',
      'publish',
      'set-environment',
      'remove-proxy',
      'roots',
    ]);
    expect(result.proxyReplaced).toBe(true);
    expect(guest.state.roots).not.toContain(proxyOld.sha256);
    expect(guest.state.roots).toContain(proxyNew.sha256);
  });

  it('reports only counts and abbreviated fingerprints as progress', async () => {
    const guest = freshGuest();
    const progress: string[] = [];
    await reconcile(guest, { progress });
    const text = progress.join('\n');
    expect(progress.length).toBeGreaterThan(0);
    expect(text).toContain(proxyNew.sha256.slice(0, 12));
    expect(text).not.toContain(proxyNew.sha256);
    expect(text).not.toContain(ambientA.sha256);
    expect(text).not.toContain('BEGIN CERTIFICATE');
    expect(text).not.toContain('applier-');
  });

  describe('typed failure per operation', () => {
    it('names host enumeration when the host cannot enumerate its roots', async () => {
      const guest = freshGuest();
      const error = await failureOf(
        reconcile(guest, { hostExec: hostExecFor([], 1, 'Access is denied') }),
      );
      expect(error).toMatchObject({ operation: 'host enumeration', category: 'ambient' });
      expect(error.message).toContain('host enumeration');
      expect(guest.invoked).toHaveLength(0);
    });

    it('names host enumeration when the environment cert.pem is not a valid certificate', async () => {
      const guest = freshGuest();
      const error = await failureOf(reconcile(guest, { proxyPem: 'nonsense' }));
      expect(error).toMatchObject({ operation: 'host enumeration', category: 'proxy' });
      expect(guest.invoked).toHaveLength(0);
    });

    it('names guest fingerprint when the guest cannot report its store', async () => {
      const guest = freshGuest({
        override: { inspect: { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false } },
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({ operation: 'guest fingerprint', category: 'store' });
      expect(guest.invoked).toHaveLength(1);
    });

    it('names guest fingerprint for a malformed managed PEM, without touching the guest further', async () => {
      const guest = freshGuest({
        ambientFiles: [{ fileName: `ambient-${ambientA.sha256}.pem`, text: 'not a cert' }],
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({
        operation: 'guest fingerprint',
        category: 'ambient',
        fingerprint: ambientA.sha256.slice(0, 12),
      });
      expect(guest.invoked.map((i) => i.operation)).toEqual(['inspect']);
    });

    it('names ambient import, with the failing root abbreviated', async () => {
      const guest = freshGuest({
        override: {
          'import-ambient': ok({
            Outcome: 'error',
            Fingerprint: ambientB.sha256,
            Message: 'Access denied',
          }),
        },
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({
        operation: 'ambient import',
        category: 'ambient',
        fingerprint: ambientB.sha256.slice(0, 12),
      });
      expect(error.message).not.toContain(ambientB.sha256);
    });

    it('names ambient import when writing the managed ambient PEMs fails', async () => {
      const guest = freshGuest({
        override: { 'write-ambient-pems': ok({ Outcome: 'error', Message: 'disk full' }) },
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({ operation: 'ambient import', category: 'ambient' });
      expect(guest.invoked.map((i) => i.operation)).not.toContain('import-ambient');
    });

    it('names proxy import', async () => {
      const guest = freshGuest({
        override: {
          'import-proxy': ok({ Outcome: 'error', Fingerprint: proxyNew.sha256, Message: 'denied' }),
        },
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({
        operation: 'proxy import',
        category: 'proxy',
        fingerprint: proxyNew.sha256.slice(0, 12),
      });
    });

    it('names verification when an imported certificate is not in the re-read store', async () => {
      const guest = freshGuest({
        override: { roots: ok({ Outcome: 'ok', Roots: [ambientA.sha256, ambientB.sha256] }) },
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({
        operation: 'verification',
        category: 'store',
        fingerprint: proxyNew.sha256.slice(0, 12),
      });
      // nothing is published on a failed verification
      expect(guest.invoked.map((i) => i.operation)).not.toContain('publish');
    });

    it('names bundle publication', async () => {
      const guest = freshGuest({
        override: { publish: ok({ Outcome: 'error', Message: 'Access to the path is denied' }) },
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({ operation: 'bundle publication', category: 'bundle' });
      expect(guest.invoked.map((i) => i.operation)).not.toContain('set-environment');
    });

    it('names environment update', async () => {
      const guest = freshGuest({
        override: {
          'set-environment': ok({
            Outcome: 'error',
            Fingerprint: ambientA.sha256,
            Message: 'the combined bundle is missing 1 expected certificate(s)',
          }),
        },
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({
        operation: 'environment update',
        category: 'environment',
        fingerprint: ambientA.sha256.slice(0, 12),
      });
    });

    const rotation = (override: GuestState['override']) =>
      freshGuest({
        roots: [ambientA.sha256, proxyOld.sha256],
        manifestText: JSON.stringify({
          version: 1,
          ambient: [ambientA.sha256],
          proxy: proxyOld.sha256,
        }),
        proxyFileText: proxyOld.pem,
        ambientFiles: [{ fileName: `ambient-${ambientA.sha256}.pem`, text: ambientA.pem }],
        override,
      });

    it('names proxy cleanup, after the new proxy was published', async () => {
      const guest = rotation({
        'remove-proxy': ok({ Outcome: 'error', Fingerprint: proxyOld.sha256, Message: 'denied' }),
      });
      const error = await failureOf(reconcile(guest, { hostRoots: [ambientA] }));
      expect(error).toMatchObject({
        operation: 'proxy cleanup',
        category: 'proxy',
        fingerprint: proxyOld.sha256.slice(0, 12),
      });
      const operations = guest.invoked.map((i) => i.operation);
      expect(operations.indexOf('publish')).toBeLessThan(operations.indexOf('remove-proxy'));
    });

    it('names proxy cleanup for ambiguous ownership and issues no mutating operation', async () => {
      const guest = freshGuest({
        roots: [ambientA.sha256, proxyOld.sha256],
        manifestText: JSON.stringify({
          version: 1,
          ambient: [ambientA.sha256],
          proxy: proxyOld.sha256,
        }),
        proxyFileText: ambientB.pem,
        ambientFiles: [{ fileName: `ambient-${ambientA.sha256}.pem`, text: ambientA.pem }],
      });
      const error = await failureOf(reconcile(guest, { hostRoots: [ambientA] }));
      expect(error).toMatchObject({ operation: 'proxy cleanup', category: 'proxy' });
      expect(guest.invoked.map((i) => i.operation)).toEqual(['inspect']);
      expect(guest.state.roots).toContain(proxyOld.sha256);
    });

    it('fails when an invocation exceeds its deadline', async () => {
      const guest = freshGuest({
        override: { publish: { exitCode: 124, stdout: '', stderr: '', timedOut: true } },
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({ operation: 'bundle publication' });
      expect(error.message).toContain('2 minutes');
    });

    it('fails when the guest returns output it cannot read', async () => {
      const guest = freshGuest({
        override: { publish: { exitCode: 0, stdout: 'garbage', stderr: '', timedOut: false } },
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({ operation: 'bundle publication' });
    });

    it('wraps a transport failure with the operation that was running', async () => {
      const guest = freshGuest({
        override: { publish: new WindowsGuestError('transport', 'the VM went away') },
      });
      const error = await failureOf(reconcile(guest));
      expect(error).toMatchObject({ operation: 'bundle publication' });
      expect(error.message).toContain('the VM went away');
    });

    it('lets a cancellation through as itself', async () => {
      const cancelled = new WindowsGuestError('cancelled', 'cancelled');
      const guest = freshGuest({ override: { publish: cancelled } });
      await expect(reconcile(guest)).rejects.toBe(cancelled);
    });

    it('stops at the first failure and never rolls anything back', async () => {
      const guest = freshGuest({
        override: { publish: ok({ Outcome: 'error', Message: 'denied' }) },
      });
      await failureOf(reconcile(guest));
      const operations = guest.invoked.map((i) => i.operation);
      expect(operations).toEqual([
        'inspect',
        'write-ambient-pems',
        'import-ambient',
        'import-proxy',
        'roots',
        'publish',
      ]);
      // the imports stay in the store as safe residual state
      expect(guest.state.roots).toEqual(
        expect.arrayContaining([ambientA.sha256, ambientB.sha256, proxyNew.sha256]),
      );
    });
  });

  describe('redaction', () => {
    it('never puts PEM content, long base64, or the full fingerprint in the error', async () => {
      const guest = freshGuest({
        override: {
          publish: {
            exitCode: 1,
            stdout: '',
            stderr:
              `bad input ${proxyNew.pem}\n` +
              `blob ${der64(ambientA.pem)} ` +
              `and ${proxyNew.sha256} in CN=applier-proxy-new`,
            timedOut: false,
          },
        },
      });
      const error = await failureOf(reconcile(guest));
      expect(error.message).not.toContain('BEGIN CERTIFICATE');
      expect(error.message).not.toContain(der64(ambientA.pem));
      expect(error.message).not.toContain(proxyNew.pem.split(/\r?\n/)[1]);
      expect(error.message).not.toContain(proxyNew.sha256);
      expect(error.message).toContain('bundle publication');
    });

    it('does not echo the enumeration output when the host result cannot be parsed', async () => {
      const guest = freshGuest();
      const error = await failureOf(
        reconcile(guest, { hostExec: hostExecFor([], 0, `not json ${der64(ambientA.pem)}`) }),
      );
      expect(error.operation).toBe('host enumeration');
      expect(error.message).not.toContain(der64(ambientA.pem));
    });

    it('never puts guest-reported messages that carry secrets beyond the redacted, bounded detail', async () => {
      const guest = freshGuest({
        override: {
          publish: ok({ Outcome: 'error', Message: `x${'y'.repeat(5000)}` }),
        },
      });
      const error = await failureOf(reconcile(guest));
      expect(error.message.length).toBeLessThan(1000);
    });
  });
});
