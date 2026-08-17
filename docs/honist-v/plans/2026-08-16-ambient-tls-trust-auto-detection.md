# Ambient TLS Trust Auto-Detection Implementation Plan

**Goal:** Give `setup-guest-unix` an unconditional step that detects the host's ambient TLS-interception CA(s) (if any) and propagates them into the provisioned guest, replacing the deferred manual `--extra-ca` flag and the harness-only `SUSENTORNO_TEST_EXTRA_CA` stopgap entirely.

**Architecture:** A host-side detector (`src/guestSetup/hostTrustStore.ts`) enumerates and filters Windows' trusted roots over `PowerShellExec`. A guest-side installer (`src/guestSetup/ambientTrust.ts`) diffs those candidates against the guest's own already-trusted fingerprints over a newly capture-capable `RemoteExec`, installs only the difference, and wires `NODE_EXTRA_CA_CERTS` to the guest's full system bundle so Node-based tooling sees it too. Both run once, early, in `setup-guest-unix`, and nothing is ever removed — this trust is a standing fact about the host's network location, not an artifact of one provisioning run.

**Tech Stack:** TypeScript, Vitest (`unit` and `guest` tiers), Windows PowerShell 5.1 via the existing `PowerShellExec` seam, OpenSSH via the existing `RemoteExec` seam, `node-forge`-backed cert generation (`src/ca.ts`), `node:crypto` for SHA-256 fingerprinting.

## Global Constraints

- **Detection is the sole mechanism.** No `--extra-ca` flag, no operator-supplied override, per the approved spec.
- **Ambient trust persists indefinitely in the guest.** Nothing removes it after isolation — see the spec's "Why over-inclusion... and why this trust persists" section. No reconciliation machinery is added; a later host-side change is picked up only by re-running `setup-guest-unix`.
- **`propagateAmbientTrust` runs before `ensureKvpDaemon`, `mountShare`, and `runPreScripts`**, immediately after the SSH connection is established in `setup-guest-unix`.
- **Fingerprints are SHA-256 over DER bytes, never over PEM text**, on both the host and guest side of the diff.
- **Dedup by SHA-256 across `LocalMachine\Root` and `CurrentUser\Root`** before anything downstream sees the candidates.
- **Exclude `Cert:\LocalMachine\Disallowed`/`Cert:\CurrentUser\Disallowed` thumbprints, and certs whose `EnhancedKeyUsageList` is non-empty and includes neither Server Authentication (`1.3.6.1.5.5.7.3.1`) nor `anyExtendedKeyUsage` (`2.5.29.37.0`).**
- **`NODE_EXTRA_CA_CERTS` points at `/etc/ssl/certs/ca-certificates.crt`** (the full system bundle), set two ways: written into `/etc/environment` unconditionally by `propagateAmbientTrust` (before any pre-script runs), and by the one-line `nn-configure-network.sh` change (so it stays correct even for a shell that only reads `/etc/profile.d`).
- **PowerShell enumeration sets `$ErrorActionPreference = 'Stop'`**; non-zero exits and JSON parse failures both surface as the module's own typed error, never a raw exception or silent empty result.
- **Follow the existing `buildXCommand()`/`parseX()` plus thin-executor split** — `mountShare.ts`, `kvpDaemon.ts`, and `hyperVQueries.ts` are the models.
- Run `pnpm format && pnpm lint && pnpm typecheck` before every commit, matching the rest of this codebase's tasks.
- **Envoy upstream certificate validation is out of scope for this plan.** `enumerateHostTrustedRoots`'s output is shaped for that reuse later, but no `envoyConfig.ts`/`docker-compose.yml` change happens here.

## Plan deviations from the spec

1. **`RemoteExec` itself is not modified.** The spec's Components section described extending `RemoteExec` with a `capture()` method directly. Doing that literally would break every existing fake `RemoteExec` object across the test suite (`mountShare.test.ts`, `kvpDaemon.test.ts`, `runPreScripts.test.ts`, etc. all implement the interface as a two-method object literal). Instead, a new interface `RemoteExecWithCapture extends RemoteExec` adds `capture()`, and only `createSshRemoteExec()`'s and `createHarnessRemoteExec()`'s return types widen to it. Every existing consumer that only needs `run`/`copyFile` is unaffected; `propagateAmbientTrust` is the only function that requires the wider type.
2. **The phase test gets its own guest role and file, not a new `describe` block in `tests/guest/phases.test.ts`.** The existing per-file-per-role pattern (`phases.test.ts`/`'phases'`, `e2e.test.ts`/`'e2e'`, `fresh.test.ts`/`'fresh'`) is followed rather than sharing a role across two files. `tests/guest/hyperv/sweep.ts` was checked and sweeps by name prefix, not by an enumerated role list, so adding a fourth role needs no change there.

---

## Task 1: `RemoteExec` gains a capture-capable variant

**Files:**

- Modify: `src/guestSetup/remoteExec.ts`
- Modify: `tests/guest/guestExec.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  ```typescript
  // src/guestSetup/remoteExec.ts
  export interface RemoteExecCaptureResult extends RemoteExecResult {
    stdout: string;
  }
  export interface RemoteExecWithCapture extends RemoteExec {
    capture(remoteCommand: string): Promise<RemoteExecCaptureResult>;
  }
  export function createSshRemoteExec(target: SshTarget): RemoteExecWithCapture;

  // tests/guest/guestExec.ts
  export function createHarnessRemoteExec(target: SshTarget): RemoteExecWithCapture;
  ```

This is the one purely mechanical task with no new business logic — `capture()`'s execa wrapper follows the exact same "no dedicated unit test" precedent `run()`/`copyFile()` already have (see the doc comment on `createSshRemoteExec` today), since it's a thin process wrapper exercised for real by the guest tier, not by mocking `execa`.

- [ ] **Step 1: Add the new types and widen `createSshRemoteExec`'s return type**

Modify `src/guestSetup/remoteExec.ts`. Replace the `RemoteExecResult`/`RemoteExec` block (current lines 4-18):

```typescript
export interface RemoteExecResult {
  exitCode: number;
}

export interface RemoteExecCaptureResult extends RemoteExecResult {
  stdout: string;
}

/**
 * Injectable seam for "run this command on the guest and get its exit code
 * back." Production wires this to real ssh/scp (createSshRemoteExec, below);
 * tests/guest/ wires it to the existing QEMU-guest harness; unit tests wire
 * it to an in-memory fake. mountShare and runPreScripts are written once
 * against this interface.
 */
export interface RemoteExec {
  run(remoteCommand: string): Promise<RemoteExecResult>;
  copyFile(localPath: string, remoteDestPath: string): Promise<RemoteExecResult>;
}

/**
 * Widens RemoteExec with a read-only, stdout-capturing variant of run() — for
 * queries with no interactive output expected (sudo prompts, package-manager
 * progress), not a replacement for it. Kept as a separate interface rather
 * than added to RemoteExec directly, so every existing fake RemoteExec in the
 * test suite (which only ever implements run/copyFile) keeps compiling
 * unchanged; only code that actually needs captured stdout asks for this
 * wider type.
 */
export interface RemoteExecWithCapture extends RemoteExec {
  capture(remoteCommand: string): Promise<RemoteExecCaptureResult>;
}
```

Then replace `createSshRemoteExec` (current lines 51-68):

```typescript
export function createSshRemoteExec(target: SshTarget): RemoteExecWithCapture {
  return {
    async run(remoteCommand: string): Promise<RemoteExecResult> {
      const result = await execa('ssh', buildSshRunArgv(target, remoteCommand), {
        stdio: 'inherit',
        reject: false,
      });
      return { exitCode: result.exitCode ?? 1 };
    },
    async copyFile(localPath: string, remoteDestPath: string): Promise<RemoteExecResult> {
      const result = await execa('scp', buildScpArgv(target, localPath, remoteDestPath), {
        stdio: 'inherit',
        reject: false,
      });
      return { exitCode: result.exitCode ?? 1 };
    },
    async capture(remoteCommand: string): Promise<RemoteExecCaptureResult> {
      const result = await execa('ssh', buildSshRunArgv(target, remoteCommand), {
        reject: false,
        all: true,
      });
      return { exitCode: result.exitCode ?? 1, stdout: result.all ?? '' };
    },
  };
}
```

`capture()` deliberately does not use `stdio: 'inherit'` — it needs the child's stdout back as a string, so it follows the same `all: true` pattern `createRealPowerShellExec` already uses in `src/guestSetup/powerShellExec.ts`.

- [ ] **Step 2: Run the existing unit tests to confirm nothing broke**

Run: `pnpm typecheck && pnpm vitest run tests/unit/guestSetup/remoteExec.test.ts`
Expected: PASS — the two existing tests only exercise `buildSshRunArgv`/`buildScpArgv`, which are unchanged.

- [ ] **Step 3: Give the guest-tier harness the same capability**

Modify `tests/guest/guestExec.ts`. Add `RemoteExecWithCapture` to the existing import line:

```typescript
import {
  buildScpArgv,
  buildSshRunArgv,
  type RemoteExec,
  type RemoteExecResult,
  type RemoteExecWithCapture,
  type SshTarget,
} from '../../src/guestSetup/remoteExec';
```

Replace `createHarnessRemoteExec`'s signature and body to add `capture`, reusing the file's own existing `guestCapture` helper (defined just below it in the same file) rather than duplicating the execa call:

```typescript
export function createHarnessRemoteExec(target: SshTarget): RemoteExecWithCapture {
  const options = buildHarnessSshOptions();
  const run = async (command: 'ssh' | 'scp', args: string[]): Promise<RemoteExecResult> => {
    const result = await execa(command, [...options, ...args], { reject: false, all: true });
    return { exitCode: result.exitCode ?? 1 };
  };
  return {
    run: (remoteCommand) => run('ssh', buildSshRunArgv(target, remoteCommand)),
    copyFile: (localPath, remoteDestPath) =>
      run('scp', buildScpArgv(target, localPath, remoteDestPath)),
    capture: (remoteCommand) => guestCapture(target, remoteCommand),
  };
}
```

`guestCapture`'s existing return shape (`{ stdout: string; exitCode: number }`) already matches `RemoteExecCaptureResult` structurally, so this is a direct delegation, not new logic. `guestCapture` is declared later in the same file — this works because both are function declarations, not `const`, so hoisting applies within the module.

- [ ] **Step 4: Typecheck the guest tier**

Run: `pnpm typecheck`
Expected: PASS. This only typechecks — the guest tier itself needs real Hyper-V and is exercised for real in Task 7, not here.

- [ ] **Step 5: Format, lint, and commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add src/guestSetup/remoteExec.ts tests/guest/guestExec.ts
git commit -m "feat(guestSetup): add a stdout-capturing RemoteExec variant"
```

---

## Task 2: `src/guestSetup/hostTrustStore.ts` — enumerate and filter the host's trusted roots

**Files:**

- Create: `src/guestSetup/hostTrustStore.ts`
- Test: `tests/unit/guestSetup/hostTrustStore.test.ts`

**Interfaces:**

- Consumes: `PowerShellExec` from `src/guestSetup/powerShellExec` (existing).
- Produces:
  ```typescript
  export interface HostTrustedRoot {
    thumbprint: string;
    sha256: string;
    pem: string;
  }
  export function buildEnumerateTrustedRootsCommand(): string;
  export function parseTrustedRootsResult(stdout: string): HostTrustedRoot[];
  export function dedupeBySha256(roots: HostTrustedRoot[]): HostTrustedRoot[];
  export class HostTrustStoreError extends Error {}
  export async function enumerateHostTrustedRoots(exec: PowerShellExec): Promise<HostTrustedRoot[]>;
  ```

The PowerShell command does the Disallowed/EKU filtering itself (so a malicious or noisy store can't produce a huge JSON blob that TypeScript then has to filter down); TypeScript only computes the SHA-256/PEM derivation and the cross-store dedup. This split is the spec's own note (§"Why over-inclusion...") applied literally: enumeration + exclusion happen where the store lives, comparison happens where the comparison key (SHA-256) is easiest to compute.

**Before writing the builder for real:** the spec flags `EnhancedKeyUsageList`'s exact runtime behavior — whether it reliably distinguishes the local "Intended Purposes" store property from the embedded X.509 EKU extension, and whether `Cert:\*\Disallowed` enumeration reflects Windows' effective CTL decision — as unverified. Run this on a real Windows machine before trusting the builder below, and adjust it if reality differs:

```powershell
# A cert with no local purpose restriction — EnhancedKeyUsageList should be empty.
(Get-ChildItem Cert:\LocalMachine\Root | Select-Object -First 1).EnhancedKeyUsageList

# certmgr.msc -> pick a root -> Properties -> "Enable only the following purposes" ->
# restrict it to something other than Server Authentication, then:
(Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like '*<that root>*' }).EnhancedKeyUsageList
# Expect exactly the purposes you picked, as a list of Oid objects with .Value/.FriendlyName.

# Confirm Cert:\*\Disallowed is queryable the same way as Root:
Get-ChildItem Cert:\LocalMachine\Disallowed | Select-Object Subject, Thumbprint
```

If `EnhancedKeyUsageList` turns out not to distinguish local restriction from the embedded EKU extension, or `Cert:\*\Disallowed` doesn't reflect what a real `openssl`/browser validation would reject, note the actual behavior in a comment at the top of `hostTrustStore.ts` and adjust Step 3 below accordingly before proceeding — do not proceed on the untested assumption.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/guestSetup/hostTrustStore.test.ts`:

```typescript
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
    expect(root.sha256).toBe(createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'));
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/guestSetup/hostTrustStore.test.ts`
Expected: FAIL — `Cannot find module '../../../src/guestSetup/hostTrustStore'`.

- [ ] **Step 3: Write `src/guestSetup/hostTrustStore.ts`**

```typescript
import { createHash } from 'node:crypto';
import type { PowerShellExec } from './powerShellExec';

export interface HostTrustedRoot {
  /** Windows' own thumbprint — carried through for logging, not the comparison key. */
  thumbprint: string;
  /** SHA-256 over the certificate's DER encoding — the actual diff/dedup key. */
  sha256: string;
  pem: string;
}

const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
const ANY_EKU_OID = '2.5.29.37.0';

/**
 * Enumeration and filtering both happen here, in PowerShell, rather than
 * pulling every raw store entry back into TypeScript first — the exclusions
 * (Disallowed, EKU) are about which certs the host itself would actually
 * accept, which is a fact about the store, not about the diff this module's
 * caller goes on to compute.
 */
export function buildEnumerateTrustedRootsCommand(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$disallowed = @(Get-ChildItem Cert:\\LocalMachine\\Disallowed, Cert:\\CurrentUser\\Disallowed ' +
      '-ErrorAction SilentlyContinue | Select-Object -ExpandProperty Thumbprint)',
    `$serverAuthOid = '${SERVER_AUTH_OID}'`,
    `$anyEkuOid = '${ANY_EKU_OID}'`,
    'Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root | ' +
      'Where-Object { $disallowed -notcontains $_.Thumbprint -and ' +
      '($_.EnhancedKeyUsageList.Count -eq 0 -or ' +
      '($_.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq $serverAuthOid -or $_.ObjectId -eq $anyEkuOid })) } | ' +
      'ForEach-Object { [PSCustomObject]@{ Thumbprint = $_.Thumbprint; ' +
      'RawDataBase64 = [Convert]::ToBase64String($_.RawData) } } | ' +
      'ConvertTo-Json -Compress',
  ].join('; ');
}

interface RawTrustedRoot {
  Thumbprint?: unknown;
  RawDataBase64?: unknown;
}

function pemFromDer(der: Buffer): string {
  const base64 = der.toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** Individually malformed entries are dropped rather than failing the whole batch; unparseable JSON throws. */
export function parseTrustedRootsResult(stdout: string): HostTrustedRoot[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawTrustedRoot[];
  const roots: HostTrustedRoot[] = [];
  for (const entry of list) {
    if (typeof entry?.Thumbprint !== 'string' || typeof entry?.RawDataBase64 !== 'string') continue;
    const der = Buffer.from(entry.RawDataBase64, 'base64');
    roots.push({
      thumbprint: entry.Thumbprint,
      sha256: createHash('sha256').update(der).digest('hex'),
      pem: pemFromDer(der),
    });
  }
  return roots;
}

export function dedupeBySha256(roots: HostTrustedRoot[]): HostTrustedRoot[] {
  const seen = new Map<string, HostTrustedRoot>();
  for (const root of roots) {
    if (!seen.has(root.sha256)) seen.set(root.sha256, root);
  }
  return [...seen.values()];
}

export class HostTrustStoreError extends Error {}

export async function enumerateHostTrustedRoots(exec: PowerShellExec): Promise<HostTrustedRoot[]> {
  const { exitCode, stdout } = await exec.run(buildEnumerateTrustedRootsCommand());
  if (exitCode !== 0) {
    throw new HostTrustStoreError(
      `hostTrustStore: enumeration exited with code ${exitCode}: ${stdout}`,
    );
  }
  let roots: HostTrustedRoot[];
  try {
    roots = parseTrustedRootsResult(stdout);
  } catch {
    throw new HostTrustStoreError(`hostTrustStore: could not parse enumeration output: ${stdout}`);
  }
  return dedupeBySha256(roots);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/guestSetup/hostTrustStore.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Format, lint, typecheck, and commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add src/guestSetup/hostTrustStore.ts tests/unit/guestSetup/hostTrustStore.test.ts
git commit -m "feat(guestSetup): enumerate and filter the host's trusted roots"
```

---

## Task 3: `src/guestSetup/ambientTrust.ts` — diff, install, and wire NODE_EXTRA_CA_CERTS

**Files:**

- Create: `src/guestSetup/ambientTrust.ts`
- Test: `tests/unit/guestSetup/ambientTrust.test.ts`

**Interfaces:**

- Consumes: `HostTrustedRoot`, `enumerateHostTrustedRoots` from `src/guestSetup/hostTrustStore` (Task 2); `RemoteExecWithCapture` from `src/guestSetup/remoteExec` (Task 1); `PowerShellExec` from `src/guestSetup/powerShellExec`.
- Produces:
  ```typescript
  export class AmbientTrustError extends Error {}
  export function buildSetNodeExtraCaCertsCommand(): string;
  export function buildListGuestFingerprintsCommand(): string;
  export function parseGuestFingerprints(stdout: string): string[];
  export function diffAmbientCandidates(
    hostRoots: HostTrustedRoot[],
    guestFingerprints: string[],
  ): HostTrustedRoot[];
  export function ambientCaFileName(sha256: string): string;
  export function buildInstallAmbientCaCommand(fileName: string, pem: string): string;
  export async function propagateAmbientTrust(
    exec: PowerShellExec,
    remoteExec: RemoteExecWithCapture,
    onStep?: (message: string) => void,
  ): Promise<string[]>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/guestSetup/ambientTrust.test.ts`:

```typescript
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
    expect(parseGuestFingerprints(stdout)).toEqual([('abcdef0123456789'.repeat(4))]);
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

function fakeRemoteExec(overrides: {
  runResult?: RemoteExecResult;
  captureResult?: RemoteExecCaptureResult;
} = {}): { remoteExec: RemoteExecWithCapture; runCalls: string[] } {
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/guestSetup/ambientTrust.test.ts`
Expected: FAIL — `Cannot find module '../../../src/guestSetup/ambientTrust'`.

- [ ] **Step 3: Write `src/guestSetup/ambientTrust.ts`**

```typescript
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
 * base64 over the wire, same reasoning as tests/guest/extraCas.ts's
 * buildInstallExtraCaCommand: the PEM crosses bash -ic as one shell-quoted
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
      throw new AmbientTrustError(`ambientTrust: could not install ${fileName} (exit ${result.exitCode})`);
    }
    installed.push(fileName);
  }

  onStep(`trust ${installed.length} ambient CA(s)`);
  const updateResult = await remoteExec.run('sudo update-ca-certificates');
  if (updateResult.exitCode !== 0) {
    throw new AmbientTrustError(
      `ambientTrust: update-ca-certificates failed (exit ${updateResult.exitCode})`,
    );
  }

  return installed;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/guestSetup/ambientTrust.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Format, lint, typecheck, and commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add src/guestSetup/ambientTrust.ts tests/unit/guestSetup/ambientTrust.test.ts
git commit -m "feat(guestSetup): diff, install, and wire NODE_EXTRA_CA_CERTS for ambient trust"
```

---

## Task 4: Wire `propagateAmbientTrust` into `setup-guest-unix`

**Files:**

- Modify: `src/commands/setupGuestUnix.ts`

**Interfaces:**

- Consumes: `propagateAmbientTrust`, `AmbientTrustError` from `src/guestSetup/ambientTrust` (Task 3); `HostTrustStoreError` from `src/guestSetup/hostTrustStore` (Task 2).
- Produces: nothing new — this only changes the command's internal sequencing and error handling.

- [ ] **Step 1: Add the imports**

Modify `src/commands/setupGuestUnix.ts`. Add to the existing import block (after the `mountShare` import):

```typescript
import { propagateAmbientTrust, AmbientTrustError } from '../guestSetup/ambientTrust';
import { HostTrustStoreError } from '../guestSetup/hostTrustStore';
```

- [ ] **Step 2: Call it right after the SSH connection is established, before `ensureKvpDaemon`**

Replace this block:

```typescript
        const remoteExec = createSshRemoteExec({ address: setupAddress, username });

        await ensureKvpDaemon(remoteExec, onStep);
```

with:

```typescript
        const remoteExec = createSshRemoteExec({ address: setupAddress, username });

        await propagateAmbientTrust(exec, remoteExec, onStep);

        await ensureKvpDaemon(remoteExec, onStep);
```

`remoteExec`'s inferred type is already `RemoteExecWithCapture` after Task 1's change to `createSshRemoteExec`'s return type, so no type annotation changes are needed here.

- [ ] **Step 3: Add the two new error types to the existing catch block**

Replace the `catch` block's `instanceof` chain:

```typescript
        if (
          error instanceof MountShareError ||
          error instanceof RunPreScriptsError ||
          error instanceof RunPostScriptsError ||
          error instanceof EnsureKvpDaemonError ||
          error instanceof VmReconcileError ||
          error instanceof HostTrustStoreError ||
          error instanceof AmbientTrustError
        ) {
```

- [ ] **Step 4: Typecheck and run the existing command-level tests**

Run: `pnpm typecheck && pnpm vitest run tests/unit/commands/setupGuestUnix.test.ts tests/cli/setupGuestUnix.test.ts`
Expected: PASS unchanged — `tests/unit/commands/setupGuestUnix.test.ts` only covers the CLI option surface and `resolveGuestNetwork`, neither of which this task touches; `tests/cli/setupGuestUnix.test.ts` (if it invokes the command against a live target) is exercised for real in Task 7/e2e, not here.

- [ ] **Step 5: Format, lint, typecheck, and commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add src/commands/setupGuestUnix.ts
git commit -m "feat(setup-guest-unix): propagate ambient trust before any guest HTTPS call"
```

---

## Task 5: Point `nn-configure-network.sh`'s `NODE_EXTRA_CA_CERTS` at the full system bundle

**Files:**

- Modify: `templates/vm-shared-linux/pre-scripts/nn-configure-network.sh:24`
- Modify: `tests/guest/phases.test.ts:173-176`

**Interfaces:**

- Consumes: nothing new.
- Produces: nothing new — this is the template-side half of the `NODE_EXTRA_CA_CERTS` reconciliation Task 3 already covers on the ambient-CA side.

- [ ] **Step 1: Change the one line**

Modify `templates/vm-shared-linux/pre-scripts/nn-configure-network.sh`. Replace line 24:

```bash
echo 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt' | sudo tee /etc/profile.d/node-extra-ca-certs.sh > /dev/null
```

with:

```bash
echo 'export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt' | sudo tee /etc/profile.d/node-extra-ca-certs.sh > /dev/null
```

This file is under `templates/`, which is prettier-ignored — no `pnpm format` step touches it.

- [ ] **Step 2: Update the test that asserts the old value**

Modify `tests/guest/phases.test.ts`. Replace the existing test (lines 173-176):

```typescript
  it('configures NODE_EXTRA_CA_CERTS for login shells', async () => {
    const { stdout } = await guestCapture(target, "bash -lc 'echo $NODE_EXTRA_CA_CERTS'");
    expect(stdout).toContain('susentorno-proxy-certificate-authority.crt');
  });
```

with:

```typescript
  it('configures NODE_EXTRA_CA_CERTS for login shells, pointing at the full system bundle', async () => {
    const { stdout } = await guestCapture(target, "bash -lc 'echo $NODE_EXTRA_CA_CERTS'");
    expect(stdout).toContain('/etc/ssl/certs/ca-certificates.crt');
  });
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. This test only runs for real in the `guest` tier (Task 7's territory for actually exercising it); typecheck confirms the file still compiles.

- [ ] **Step 4: Format, lint, typecheck, and commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add templates/vm-shared-linux/pre-scripts/nn-configure-network.sh tests/guest/phases.test.ts
git commit -m "fix(templates): point NODE_EXTRA_CA_CERTS at the full system bundle, not one file"
```

---

## Task 6: Remove the harness-side `SUSENTORNO_TEST_EXTRA_CA` workaround

**Files:**

- Delete: `tests/guest/extraCas.ts`
- Delete: `tests/unit/guest/extraCas.test.ts`
- Modify: `tests/guest/e2e.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: nothing — this is pure removal now that Task 4 makes `setup-guest-unix` itself responsible for the same job.

- [ ] **Step 1: Delete the two files**

```bash
git rm tests/guest/extraCas.ts tests/unit/guest/extraCas.test.ts
```

- [ ] **Step 2: Remove the manual staging from `e2e.test.ts`**

Modify `tests/guest/e2e.test.ts`. Remove the import (current line 19):

```typescript
import { installExtraCas } from './extraCas';
```

Remove the call and its explanatory comment (currently just before `await isolateVmToSwitch(...)`):

```typescript
  // Only meaningful when this machine is behind a TLS-intercepting proxy, in
  // which case the guest inherits the interception but not the trust and the
  // pre-scripts' agent installers fail certificate verification. A no-op
  // otherwise. See tests/guest/extraCas.ts.
  await installExtraCas(target, 'e2e');
```

The real `setup-guest-unix` invocation later in this same test (the `execa('node', [cliPath, 'setup-guest-unix', ...])` call) now covers this automatically, since Task 4 wired `propagateAmbientTrust` into the command itself — that's what turns this from harness-staged behavior into covered production behavior, per the original brief's own stated goal.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — confirms no other file still imports from the deleted `tests/guest/extraCas.ts`.

Run: `grep -rn "SUSENTORNO_TEST_EXTRA_CA\|extraCas" tests/ src/ docs/honist-v/briefs/2026-08-16-ambient-tls-trust-propagation-brief.md`

Expected: no remaining references outside this brief's historical prose (which describes what was done, not a live mechanism — leave the brief's text as-is; it's a record, not documentation of a standing requirement).

- [ ] **Step 4: Format, lint, typecheck, and commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add tests/guest/e2e.test.ts
git commit -m "test: remove the SUSENTORNO_TEST_EXTRA_CA harness workaround, superseded by detection"
```

---

## Task 7: Real-guest phase test for ambient trust propagation

**Files:**

- Modify: `tests/guest/hyperv/imageCache.ts`
- Create: `tests/guest/hyperv/currentUserRoot.ts`
- Create: `tests/guest/ambientTrust.test.ts`

**Interfaces:**

- Consumes: `propagateAmbientTrust` from `src/guestSetup/ambientTrust` (Task 3); `generateRootCa`, `generateLeaf` from `src/ca.ts` (existing); `createHarnessRemoteExec`, `guestCapture` from `tests/guest/guestExec.ts` (Task 1); `createTestGuest`, `destroyTestGuest` from `tests/guest/hyperv/testGuest.ts` (existing).
- Produces:
  ```typescript
  // tests/guest/hyperv/currentUserRoot.ts
  export function buildImportCurrentUserRootCertCommand(certPath: string): string;
  export function parseImportedThumbprint(stdout: string): string;
  export function buildRemoveCurrentUserRootCertCommand(thumbprint: string): string;
  ```

This is the deterministic proof the spec asked for — it does not depend on the machine running the test actually being intercepted.

- [ ] **Step 1: Add a fourth guest role**

Modify `tests/guest/hyperv/imageCache.ts`. Change the `GuestRole` type:

```typescript
export type GuestRole = 'phases' | 'e2e' | 'fresh' | 'ambientTrust';
```

Everything else in that file (`roleVhdPath`, `roleVmName`, `rolePipeName`) is already generic over `GuestRole` and needs no further change.

- [ ] **Step 2: Write `tests/guest/hyperv/currentUserRoot.ts`**

```typescript
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

/** Imports a PEM cert file into the invoking (elevated) user's CurrentUser\Root and reports its thumbprint. */
export function buildImportCurrentUserRootCertCommand(certPath: string): string {
  return (
    `$c = Import-Certificate -FilePath ${quoteForPowerShell(certPath)} -CertStoreLocation Cert:\\CurrentUser\\Root; ` +
    '[PSCustomObject]@{ Thumbprint = $c.Thumbprint } | ConvertTo-Json -Compress'
  );
}

export function parseImportedThumbprint(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`currentUserRoot: Import-Certificate returned no thumbprint: ${stdout || '<empty>'}`);
  }
  const parsed = JSON.parse(trimmed) as { Thumbprint?: unknown };
  if (typeof parsed.Thumbprint !== 'string' || parsed.Thumbprint === '') {
    throw new Error(`currentUserRoot: Import-Certificate returned no thumbprint: ${stdout}`);
  }
  return parsed.Thumbprint;
}

export function buildRemoveCurrentUserRootCertCommand(thumbprint: string): string {
  return (
    'Get-ChildItem Cert:\\CurrentUser\\Root | ' +
    `Where-Object { $_.Thumbprint -eq ${quoteForPowerShell(thumbprint)} } | ` +
    'Remove-Item -Force'
  );
}
```

- [ ] **Step 3: Write `tests/guest/ambientTrust.test.ts`**

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { DEFAULT_NAT_ADAPTER, resolveInternalSwitchNetwork } from '../../src/runHosting/forwarder';
import { generateRootCa, generateLeaf } from '../../src/ca';
import { propagateAmbientTrust } from '../../src/guestSetup/ambientTrust';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import { startProxyStack, stopProxyStack, type ProxyStack } from '../proxyStack';
import { artifactsDir, collectDiagnostics } from './diagnostics';
import { GUEST_USERNAME } from './autoinstall';
import { createHarnessRemoteExec, guestCapture } from './guestExec';
import { ISOLATION_NAME } from './hyperv/imageCache';
import { createTestGuest, destroyTestGuest, type TestGuest } from './hyperv/testGuest';
import {
  buildImportCurrentUserRootCertCommand,
  parseImportedThumbprint,
  buildRemoveCurrentUserRootCertCommand,
} from './hyperv/currentUserRoot';

const exec = createRealPowerShellExec();

let stack: ProxyStack;
let guest: TestGuest;
let target: SshTarget;
let throwawayThumbprint: string | undefined;
let throwawayCertPath: string | undefined;

beforeAll(async () => {
  stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });
  const natNetwork = resolveInternalSwitchNetwork(DEFAULT_NAT_ADAPTER);
  if (!natNetwork) throw new Error(`ambientTrust: '${DEFAULT_NAT_ADAPTER}' has no IPv4 address`);
  guest = await createTestGuest(exec, 'ambientTrust', 'Default Switch', natNetwork, artifactsDir);
  target = { address: guest.address, username: GUEST_USERNAME };
}, 1_800_000);

afterAll(async () => {
  if (guest) {
    await collectDiagnostics(target, 'ambientTrust').catch(() => {});
    await destroyTestGuest(exec, guest).catch(() => {});
  }
  if (stack) await stopProxyStack(stack).catch(() => {});
}, 600_000);

describe('propagateAmbientTrust against a throwaway host CA', () => {
  afterEach(async () => {
    // Guaranteed regardless of assertion outcome: a lingering throwaway root in
    // Cert:\CurrentUser\Root is at worst inert (its private key is never
    // written anywhere), but it must not survive the test either way.
    if (throwawayThumbprint) {
      await exec.run(buildRemoveCurrentUserRootCertCommand(throwawayThumbprint));
      throwawayThumbprint = undefined;
    }
    if (throwawayCertPath) {
      rmSync(throwawayCertPath, { force: true });
      throwawayCertPath = undefined;
    }
  });

  it('detects a throwaway CA, installs it, chains a real leaf, and is idempotent on rerun', async () => {
    const { caCertPem, caKeyPem } = generateRootCa();
    // The leaf is minted now, while caKeyPem is still in scope — it is never
    // used again after this line, never written to disk, never passed to
    // PowerShell.
    const { leafCertPem } = generateLeaf(caCertPem, caKeyPem, ['ambient-test.invalid']);

    throwawayCertPath = join(tmpdir(), `susentorno-ambient-test-${randomBytes(8).toString('hex')}.crt`);
    writeFileSync(throwawayCertPath, caCertPem);
    const imported = await exec.run(buildImportCurrentUserRootCertCommand(throwawayCertPath));
    expect(imported.exitCode, imported.stdout).toBe(0);
    throwawayThumbprint = parseImportedThumbprint(imported.stdout);

    const remoteExec = createHarnessRemoteExec(target);
    const installedFirstRun = await propagateAmbientTrust(exec, remoteExec);
    expect(installedFirstRun).toHaveLength(1);

    const present = await guestCapture(
      target,
      `test -f /usr/local/share/ca-certificates/${installedFirstRun[0]} && echo present`,
    );
    expect(present.stdout.trim()).toBe('present');

    const encodedLeaf = Buffer.from(leafCertPem, 'utf8').toString('base64');
    const remoteLeafPath = '~/susentorno-ambient-test-leaf.pem';
    const writeLeaf = await guestCapture(
      target,
      `printf %s '${encodedLeaf}' | base64 -d > ${remoteLeafPath}`,
    );
    expect(writeLeaf.exitCode, writeLeaf.stdout).toBe(0);
    const verify = await guestCapture(
      target,
      `openssl verify -purpose sslserver -CAfile /etc/ssl/certs/ca-certificates.crt ${remoteLeafPath}`,
    );
    expect(verify.stdout).toContain('OK');

    // Idempotent rerun: nothing new to install, and the first run's file is
    // still there — this is the concrete check for "this trust persists."
    const installedSecondRun = await propagateAmbientTrust(exec, remoteExec);
    expect(installedSecondRun).toEqual([]);
    const stillPresent = await guestCapture(
      target,
      `test -f /usr/local/share/ca-certificates/${installedFirstRun[0]} && echo present`,
    );
    expect(stillPresent.stdout.trim()).toBe('present');
  }, 900_000);
});
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Run the new phase test for real**

Requires: elevated PowerShell, Hyper-V, Docker Desktop running, `ssh-agent` running, the golden VHDX already built (per `testing.md`'s existing guest-tier prerequisites).

Run: `pnpm build && pnpm vitest run --config vitest.guest.config.ts tests/guest/ambientTrust.test.ts`
Expected: PASS, 1 test. If `Import-Certificate` fails, re-check the spike notes from Task 2 — a store-scope or permission mismatch there is the most likely cause. If `openssl verify` doesn't report `OK`, check whether `capture()`'s `-t` (forced pseudo-terminal) flag from Task 1 injected any control characters into the piped-back leaf content — `buildSshRunArgv` always includes `-t`, which `run()` and `capture()` share, and this is the first place `capture()`'s output is parsed as structured multi-line data rather than just checked for a substring. If so, strip carriage returns from `RemoteExecCaptureResult.stdout` in `createSshRemoteExec`'s `capture()` implementation (Task 1) before returning it, and re-run.

- [ ] **Step 6: Run the full guest tier**

Run: `pnpm test:guest`
Expected: PASS — this is also the first time `phases.test.ts`'s updated assertion (Task 5) and `e2e.test.ts`'s updated flow (Task 6) run for real together with the new step wired into `setup-guest-unix` (Task 4).

- [ ] **Step 7: Format, lint, typecheck, and commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add tests/guest/hyperv/imageCache.ts tests/guest/hyperv/currentUserRoot.ts tests/guest/ambientTrust.test.ts
git commit -m "test: real-guest coverage for ambient trust propagation via a throwaway CA"
```

---

## Task 8: Full-suite sanity run

**Files:** none — verification only.

- [ ] **Step 1: Run the complete default pipeline**

Run: `pnpm test`
Expected: PASS end to end — `test:unit`, `test:cli`, `test:host-network`, `test:proxy-stack`, and `test:guest` all green, confirming Tasks 1-7 compose correctly and nothing outside this feature's own files regressed.

- [ ] **Step 2: Confirm the removed workaround left no dangling references**

Run: `grep -rln "SUSENTORNO_TEST_EXTRA_CA" . --include='*.ts' --include='*.md' 2>/dev/null`
Expected: no matches outside `docs/honist-v/briefs/2026-08-16-ambient-tls-trust-propagation-brief.md` (historical record, left as-is) and this plan/spec's own text.

No commit here — this task is verification of everything already committed in Tasks 1-7.
