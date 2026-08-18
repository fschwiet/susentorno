# Envoy Upstream Certificate Validation Implementation Plan

**Goal:** Make the proxy stack verify the certificate of every TLS-terminated upstream — chain *and* hostname — against a bundle assembled from Node's public root program plus the host's ambient trust, so the real GitHub/Claude/Codex credentials can no longer be injected into a connection to an impostor.

**Architecture:** A new pure module (`src/runHosting/upstreamTrustBundle.ts`) answers "which CAs does the proxy validate upstreams against," combining `tls.rootCertificates` with the host trust store enumeration that already exists for guest ambient-trust propagation. `run-hosting` calls it once at startup and writes `.susentorno/proxy/ca/upstream-trust.pem`, which `templates/proxy/docker-compose.yml` already mounts read-only into the Envoy container. `src/envoyConfig.ts` then renders a `validation_context` (with `trusted_ca` plus a DNS SAN matcher) on all four TLS-terminating cluster builders.

**Tech Stack:** TypeScript, Node 26 (`node:tls`, `node:crypto` `X509Certificate`), Envoy 1.31 (`UpstreamTlsContext`), Windows PowerShell 5.1 via `execa`, Vitest (unit / cli / proxy-stack tiers), Docker Compose, `node-forge` for test certificate minting.

**Spec:** `docs/honist-v/specs/2026-08-17-envoy-upstream-certificate-validation-design.md`

## Global Constraints

- **Windows-only host.** All PowerShell runs through `createRealPowerShellExec()`, which spawns `powershell.exe` — that is Windows PowerShell **5.1**, not `pwsh` 7. Verify PowerShell behaviour against 5.1, never against 7.
- **`run-hosting` must not gain an elevation requirement.** Reading `LocalMachine\Root` and `LocalMachine\Disallowed` with `X509Store.Open('ReadOnly')` works unelevated (measured: 58 roots, non-admin session). Do not add `checkElevated()` to `run-hosting` or to the proxy-stack tier.
- **Container path for the bundle is exactly `/etc/envoy/ca/upstream-trust.pem`.** The host path is `.susentorno/proxy/ca/upstream-trust.pem`, mounted via the existing `./ca:/etc/envoy/ca:ro` line at `templates/proxy/docker-compose.yml:11`. Do not add a new mount.
- **`--upstream-override` alone must keep rendering `ACCEPT_UNTRUSTED`.** Four existing proxy-stack suites (`githubInjection`, `codexInjection`, `stackLifecycle`, `tests/proxyStack.ts`) depend on it. Only the new `--verify-upstream-overrides <caPath>` flag opts a run into real validation.
- **No fallback on trust-store failure.** A failed enumeration or bundle assembly is a startup refusal (`process.exitCode = 1`, `return`), never a degraded public-roots-only bundle.
- **`trust_chain_verification` is omitted on the validating branch** — `VERIFY_TRUST_CHAIN` is already Envoy's default. Only the `ACCEPT_UNTRUSTED` branch names it.
- **Every task ends green on `pnpm format:check && pnpm lint && pnpm typecheck`** before its commit.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/guestSetup/hostTrustStore.ts` | Modify | Enumerate host roots **and** the distrust set; fail closed |
| `src/guestSetup/ambientTrust.ts` | Modify | One-line update for the new return shape |
| `src/runHosting/upstreamTrustBundle.ts` | **Create** | Pure bundle assembly + summary formatting + write |
| `src/envoyConfig.ts` | Modify | Render `validation_context` on the four TLS builders |
| `src/runHosting/buildConfig.ts` | Modify | Thread `verifyUpstreamOverrides` through |
| `src/envPaths.ts` | Modify | Add `upstreamTrustBundle` path |
| `src/commands/runHosting.ts` | Modify | Startup assembly, new flag, warning line |
| `tests/proxy-stack/mockUpstream.ts` | Modify | Serve a supplied cert; count connections |
| `tests/proxy-stack/upstreamValidation.test.ts` | **Create** | The five-row integration matrix |
| `docs/adr/0026-*.md` | **Create** | Record the decision and its trust boundary |

**Note on a spec inaccuracy found while planning:** the spec's component list says `src/commands/setupGuestUnix.ts` needs updating for the new return shape. It does not — `setupGuestUnix.ts:20` imports only `propagateAmbientTrust` and `AmbientTrustError`. The single `src/` caller of `enumerateHostTrustedRoots` is `src/guestSetup/ambientTrust.ts:83`. Task 1 covers it.

---

### Task 1: Host trust store returns a snapshot, and fails closed

The existing command silently swallows any error opening either `Disallowed` store (`src/guestSetup/hostTrustStore.ts:35-38`, `try { ... } catch {}`), so a failure yields an empty distrust set and everything passes the filter. It also discards the distrust set after filtering, but the bundle assembler in Task 2 needs it to filter Node's public roots too.

**Files:**

- Modify: `src/guestSetup/hostTrustStore.ts`
- Modify: `src/guestSetup/ambientTrust.ts:83`
- Test: `tests/unit/guestSetup/hostTrustStore.test.ts`
- Test: `tests/unit/guestSetup/ambientTrust.test.ts:117-120` (fixture shape only)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `HostTrustSnapshot { roots: HostTrustedRoot[]; disallowedSha256: string[] }`, returned by `enumerateHostTrustedRoots(exec: PowerShellExec): Promise<HostTrustSnapshot>`. `HostTrustedRoot { thumbprint: string; sha256: string; pem: string }` is unchanged. `parseTrustedRootsResult(stdout: string): HostTrustSnapshot` (return type changed from `HostTrustedRoot[]`). `dedupeBySha256` and `HostTrustStoreError` unchanged.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/guestSetup/hostTrustStore.test.ts`, add these two cases to the existing `describe('buildEnumerateTrustedRootsCommand')` block:

```typescript
  it('emits roots and the disallowed set as one JSON object', () => {
    expect(command).toContain('Roots = $keptRoots');
    expect(command).toContain('Disallowed = $disallowedOut');
    expect(command).toContain('ConvertTo-Json -Compress');
  });

  it('does not swallow a Disallowed enumeration failure', () => {
    expect(command).not.toContain('catch {}');
    expect(command).not.toContain('catch { }');
  });
```

Then replace the whole `describe('parseTrustedRootsResult')` block with:

```typescript
describe('parseTrustedRootsResult', () => {
  it('returns empty roots and no distrust for empty stdout', () => {
    expect(parseTrustedRootsResult('')).toEqual({ roots: [], disallowedSha256: [] });
    expect(parseTrustedRootsResult('   ')).toEqual({ roots: [], disallowedSha256: [] });
  });

  it('parses roots, deriving sha256 over the DER bytes and a valid PEM', () => {
    const base64 = fakeDerBase64('single-root');
    const stdout = JSON.stringify({
      Roots: [{ Thumbprint: 'ABC123', RawDataBase64: base64 }],
      Disallowed: [],
    });
    const { roots } = parseTrustedRootsResult(stdout);
    expect(roots).toHaveLength(1);
    expect(roots[0].thumbprint).toBe('ABC123');
    expect(roots[0].sha256).toBe(
      createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
    );
    expect(() => new X509Certificate(roots[0].pem)).not.toThrow();
  });

  it('returns the disallowed set as DER sha256 fingerprints', () => {
    const base64 = fakeDerBase64('distrusted-root');
    const stdout = JSON.stringify({
      Roots: [],
      Disallowed: [{ Thumbprint: 'BAD1', RawDataBase64: base64 }],
    });
    const { disallowedSha256 } = parseTrustedRootsResult(stdout);
    expect(disallowedSha256).toEqual([
      createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
    ]);
  });

  it('skips entries missing a thumbprint or raw data rather than throwing', () => {
    const stdout = JSON.stringify({
      Roots: [
        { Thumbprint: 'A' },
        { RawDataBase64: fakeDerBase64('no-thumbprint') },
        { Thumbprint: 'C', RawDataBase64: fakeDerBase64('root-c') },
      ],
      Disallowed: [],
    });
    expect(parseTrustedRootsResult(stdout).roots).toHaveLength(1);
  });

  it('tolerates the fields being absent entirely', () => {
    expect(parseTrustedRootsResult('{}')).toEqual({ roots: [], disallowedSha256: [] });
  });

  it('throws on unparseable JSON', () => {
    expect(() => parseTrustedRootsResult('not json')).toThrow();
  });
});
```

Then replace the whole `describe('enumerateHostTrustedRoots')` block with:

```typescript
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

  it('dedupes roots across LocalMachine and CurrentUser before returning', async () => {
    const base64 = fakeDerBase64('dup-root');
    const stdout = JSON.stringify({
      Roots: [
        { Thumbprint: 'LM', RawDataBase64: base64 },
        { Thumbprint: 'CU', RawDataBase64: base64 },
      ],
      Disallowed: [],
    });
    const { roots } = await enumerateHostTrustedRoots(fakeExec({ exitCode: 0, stdout }));
    expect(roots).toHaveLength(1);
  });

  it('carries the disallowed fingerprints out alongside the roots', async () => {
    const badBase64 = fakeDerBase64('distrusted');
    const stdout = JSON.stringify({
      Roots: [{ Thumbprint: 'OK', RawDataBase64: fakeDerBase64('good') }],
      Disallowed: [{ Thumbprint: 'NO', RawDataBase64: badBase64 }],
    });
    const snapshot = await enumerateHostTrustedRoots(fakeExec({ exitCode: 0, stdout }));
    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.disallowedSha256).toEqual([
      createHash('sha256').update(Buffer.from(badBase64, 'base64')).digest('hex'),
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/guestSetup/hostTrustStore.test.ts`

Expected: FAIL. The command-shape cases fail on missing `Roots = $keptRoots`; the parse cases fail with a type error or `expect(received).toEqual` mismatch because `parseTrustedRootsResult` still returns an array.

- [ ] **Step 3: Rewrite the command builder and parser**

Replace `buildEnumerateTrustedRootsCommand` in `src/guestSetup/hostTrustStore.ts`. Keep the existing doc comment above it and append the new paragraph shown here:

```typescript
/**
 * Enumeration and filtering both happen here, in PowerShell, rather than
 * pulling every raw store entry back into TypeScript first — the exclusions
 * (Disallowed, EKU) are about which certs the host itself would actually
 * accept, which is a fact about the store, not about the diff this module's
 * caller goes on to compute.
 *
 * Uses [X509Store] directly rather than the Cert:\ PSDrive: verified against
 * a real host that the Cert:\ provider drive is only registered by
 * PowerShell's own console-host startup, not when powershell.exe is spawned
 * as a child process with redirected stdio (execa's case here, regardless of
 * -NoProfile/-NonInteractive or stdio mode) — every Cert:\ reference fails
 * there with "Cannot find drive". [X509Store] has no such dependency, and its
 * certificates still carry the same PowerShell-added .EnhancedKeyUsageList
 * property (confirmed on the same host) and native .Thumbprint/.RawData.
 *
 * The Disallowed enumeration deliberately has no try/catch. It used to, which
 * meant any failure produced an empty distrust set and every candidate passed
 * the filter — fail-open on a trust decision. Measured on a real host,
 * X509Store.Open('ReadOnly') returns count=0 even for a bogus store name
 * rather than throwing, so the catch was never protecting against an absent
 * store; removing it costs nothing on the normal path and lets
 * $ErrorActionPreference = 'Stop' surface a genuine access failure.
 */
export function buildEnumerateTrustedRootsCommand(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$disallowed = New-Object System.Collections.Generic.List[object]',
    "foreach ($loc in 'LocalMachine','CurrentUser') { " +
      "$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('Disallowed', $loc); " +
      "$s.Open('ReadOnly'); foreach ($c in $s.Certificates) { $disallowed.Add($c) }; " +
      '$s.Close() }',
    '$disallowedThumbprints = @($disallowed | ForEach-Object { $_.Thumbprint })',
    `$serverAuthOid = '${SERVER_AUTH_OID}'`,
    `$anyEkuOid = '${ANY_EKU_OID}'`,
    '$roots = New-Object System.Collections.Generic.List[object]',
    "foreach ($loc in 'LocalMachine','CurrentUser') { " +
      "$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', $loc); " +
      "$s.Open('ReadOnly'); foreach ($c in $s.Certificates) { $roots.Add($c) }; $s.Close() }",
    '$keptRoots = @($roots | Where-Object { $disallowedThumbprints -notcontains $_.Thumbprint -and ' +
      '($_.EnhancedKeyUsageList.Count -eq 0 -or ' +
      '($_.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq $serverAuthOid -or $_.ObjectId -eq $anyEkuOid })) } | ' +
      'ForEach-Object { [PSCustomObject]@{ Thumbprint = $_.Thumbprint; ' +
      'RawDataBase64 = [Convert]::ToBase64String($_.RawData) } })',
    '$disallowedOut = @($disallowed | ForEach-Object { [PSCustomObject]@{ Thumbprint = $_.Thumbprint; ' +
      'RawDataBase64 = [Convert]::ToBase64String($_.RawData) } })',
    '[PSCustomObject]@{ Roots = $keptRoots; Disallowed = $disallowedOut } | ConvertTo-Json -Compress',
  ].join('; ');
}
```

Then replace the parser and the executor. `parseRootEntries` is a new private helper; `pemFromDer`, `dedupeBySha256`, and `HostTrustStoreError` stay exactly as they are.

```typescript
export interface HostTrustSnapshot {
  roots: HostTrustedRoot[];
  /** DER SHA-256 of every certificate in the host's Disallowed stores. */
  disallowedSha256: string[];
}

function parseRootEntries(value: unknown): HostTrustedRoot[] {
  if (value === undefined || value === null) return [];
  const list = (Array.isArray(value) ? value : [value]) as RawTrustedRoot[];
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

/** Individually malformed entries are dropped rather than failing the whole batch; unparseable JSON throws. */
export function parseTrustedRootsResult(stdout: string): HostTrustSnapshot {
  const trimmed = stdout.trim();
  if (!trimmed) return { roots: [], disallowedSha256: [] };
  const parsed = JSON.parse(trimmed) as { Roots?: unknown; Disallowed?: unknown };
  return {
    roots: parseRootEntries(parsed?.Roots),
    disallowedSha256: parseRootEntries(parsed?.Disallowed).map((entry) => entry.sha256),
  };
}

export async function enumerateHostTrustedRoots(exec: PowerShellExec): Promise<HostTrustSnapshot> {
  const { exitCode, stdout } = await exec.run(buildEnumerateTrustedRootsCommand());
  if (exitCode !== 0) {
    throw new HostTrustStoreError(
      `hostTrustStore: enumeration exited with code ${exitCode}: ${stdout}`,
    );
  }
  let snapshot: HostTrustSnapshot;
  try {
    snapshot = parseTrustedRootsResult(stdout);
  } catch {
    throw new HostTrustStoreError(`hostTrustStore: could not parse enumeration output: ${stdout}`);
  }
  return { roots: dedupeBySha256(snapshot.roots), disallowedSha256: snapshot.disallowedSha256 };
}
```

- [ ] **Step 4: Update the one `src/` caller**

In `src/guestSetup/ambientTrust.ts`, change line 83 from `const hostRoots = await enumerateHostTrustedRoots(exec);` to:

```typescript
  const { roots: hostRoots } = await enumerateHostTrustedRoots(exec);
```

- [ ] **Step 5: Update the ambient-trust test fixture to the new JSON shape**

In `tests/unit/guestSetup/ambientTrust.test.ts`, replace the `hostRootJson` constant at lines 117-120 with:

```typescript
  const hostRootJson = JSON.stringify({
    Roots: [{ Thumbprint: 'T1', RawDataBase64: Buffer.from('fake-der-bytes').toString('base64') }],
    Disallowed: [],
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/guestSetup/`

Expected: PASS, all files. `ambientTrust.test.ts` must stay green — `propagateAmbientTrust`'s behaviour is unchanged.

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add src/guestSetup/hostTrustStore.ts src/guestSetup/ambientTrust.ts tests/unit/guestSetup/hostTrustStore.test.ts tests/unit/guestSetup/ambientTrust.test.ts
git commit -m "feat(hostTrustStore): return the distrust set and stop failing open"
```

---

### Task 2: The upstream trust bundle assembler

A pure module that answers "which CAs does the proxy validate upstreams against." No knowledge of Envoy, PowerShell, or `run-hosting`.

**Files:**

- Create: `src/runHosting/upstreamTrustBundle.ts`
- Test: `tests/unit/runHosting/upstreamTrustBundle.test.ts`

**Interfaces:**

- Consumes: `HostTrustedRoot` and `HostTrustSnapshot` from Task 1 (`src/guestSetup/hostTrustStore.ts`).
- Produces:
  - `TrustBundleSources { publicRoots: string[]; hostRoots: HostTrustedRoot[]; disallowedSha256: string[]; extraCaPem?: string }`
  - `UpstreamTrustBundle { pem: string; publicRootCount: number; ambientRootCount: number; disallowedCount: number; skippedCount: number; totalCount: number }`
  - `readPublicRootProgram(): string[]`
  - `assembleUpstreamTrustBundle(sources: TrustBundleSources): UpstreamTrustBundle`
  - `parseExtraCaPem(pem: string): string`
  - `formatTrustBundleSummary(bundle: UpstreamTrustBundle): string`
  - `writeUpstreamTrustBundle(path: string, bundle: UpstreamTrustBundle): void`
  - `UpstreamTrustBundleError extends Error`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runHosting/upstreamTrustBundle.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { generateRootCa } from '../../../src/ca';
import type { HostTrustedRoot } from '../../../src/guestSetup/hostTrustStore';
import {
  assembleUpstreamTrustBundle,
  formatTrustBundleSummary,
  parseExtraCaPem,
  readPublicRootProgram,
  UpstreamTrustBundleError,
} from '../../../src/runHosting/upstreamTrustBundle';

/** A real, parseable self-signed cert — the assembler parses DER, so fakes will not do. */
function realPem(commonName: string): string {
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
  return forge.pki.certificateToPem(cert);
}

function sha256Of(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
}

function asHostRoot(pem: string): HostTrustedRoot {
  return { thumbprint: 'T', sha256: sha256Of(pem), pem };
}

const empty = { publicRoots: [], hostRoots: [], disallowedSha256: [] };

describe('readPublicRootProgram', () => {
  it('returns Node bundled roots, each of which parses as a certificate', () => {
    const roots = readPublicRootProgram();
    expect(roots.length).toBeGreaterThan(50);
    expect(() => new X509Certificate(roots[0])).not.toThrow();
  });
});

describe('assembleUpstreamTrustBundle', () => {
  it('counts a host root that is also a public root once, and not as ambient', () => {
    const shared = realPem('shared-root');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [shared],
      hostRoots: [asHostRoot(shared)],
    });
    expect(bundle.publicRootCount).toBe(1);
    expect(bundle.ambientRootCount).toBe(0);
    expect(bundle.totalCount).toBe(1);
    expect(bundle.pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
  });

  it('counts a host root absent from the public set as ambient and includes its PEM', () => {
    const publicRoot = realPem('public-root');
    const ambient = realPem('ambient-interceptor');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [publicRoot],
      hostRoots: [asHostRoot(ambient)],
    });
    expect(bundle.publicRootCount).toBe(1);
    expect(bundle.ambientRootCount).toBe(1);
    expect(bundle.pem).toContain(ambient.trimEnd());
  });

  it('excludes a PUBLIC root whose fingerprint is disallowed by the host', () => {
    const good = realPem('good-public');
    const distrusted = realPem('distrusted-public');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [good, distrusted],
      disallowedSha256: [sha256Of(distrusted)],
    });
    expect(bundle.publicRootCount).toBe(1);
    expect(bundle.disallowedCount).toBe(1);
    expect(bundle.pem).not.toContain(distrusted.trimEnd());
  });

  it('excludes a HOST root whose fingerprint is disallowed, without relying on hostTrustStore having filtered it', () => {
    const distrusted = realPem('distrusted-host');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [realPem('anchor')],
      hostRoots: [asHostRoot(distrusted)],
      disallowedSha256: [sha256Of(distrusted)],
    });
    expect(bundle.ambientRootCount).toBe(0);
    expect(bundle.disallowedCount).toBe(1);
  });

  it('matches disallowed fingerprints case-insensitively', () => {
    const distrusted = realPem('distrusted-upper');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [realPem('anchor'), distrusted],
      disallowedSha256: [sha256Of(distrusted).toUpperCase()],
    });
    expect(bundle.disallowedCount).toBe(1);
  });

  it('skips an unparseable enumerated PEM and keeps the rest', () => {
    const good = realPem('survivor');
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [good, 'not a certificate at all'],
    });
    expect(bundle.publicRootCount).toBe(1);
    expect(bundle.skippedCount).toBe(1);
    expect(bundle.totalCount).toBe(1);
  });

  it('throws when the assembled bundle would be empty', () => {
    expect(() => assembleUpstreamTrustBundle({ ...empty })).toThrow(UpstreamTrustBundleError);
  });

  it('appends extraCaPem', () => {
    const extra = generateRootCa().caCertPem;
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [realPem('anchor')],
      extraCaPem: extra,
    });
    expect(bundle.totalCount).toBe(2);
    expect(bundle.pem).toContain(extra.trimEnd());
  });

  it('throws rather than silently skipping an unparseable extraCaPem', () => {
    expect(() =>
      assembleUpstreamTrustBundle({
        ...empty,
        publicRoots: [realPem('anchor')],
        extraCaPem: 'not a certificate at all',
      }),
    ).toThrow(UpstreamTrustBundleError);
  });

  it('emits concatenated PEM where every block is delimited and newline-terminated', () => {
    const bundle = assembleUpstreamTrustBundle({
      ...empty,
      publicRoots: [realPem('a'), realPem('b')],
    });
    expect(bundle.pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
    expect(bundle.pem.match(/-----END CERTIFICATE-----/g)).toHaveLength(2);
    expect(bundle.pem.endsWith('\n')).toBe(true);
    expect(bundle.pem).not.toContain('-----END CERTIFICATE----------BEGIN CERTIFICATE-----');
  });
});

describe('parseExtraCaPem', () => {
  it('returns the PEM unchanged when it parses', () => {
    const pem = generateRootCa().caCertPem;
    expect(parseExtraCaPem(pem)).toBe(pem);
  });

  it('throws UpstreamTrustBundleError when it does not', () => {
    expect(() => parseExtraCaPem('nope')).toThrow(UpstreamTrustBundleError);
  });
});

describe('formatTrustBundleSummary', () => {
  it('reports the counts and the Node version', () => {
    const summary = formatTrustBundleSummary({
      pem: '',
      publicRootCount: 118,
      ambientRootCount: 3,
      disallowedCount: 0,
      skippedCount: 2,
      totalCount: 121,
    });
    expect(summary).toContain('118 public roots');
    expect(summary).toContain(process.version);
    expect(summary).toContain('3 ambient');
    expect(summary).toContain('121');
    expect(summary).toContain('0 disallowed');
    expect(summary).toContain('2 skipped');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/runHosting/upstreamTrustBundle.test.ts`

Expected: FAIL — `Failed to resolve import "../../../src/runHosting/upstreamTrustBundle"`.

- [ ] **Step 3: Write the implementation**

Create `src/runHosting/upstreamTrustBundle.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/runHosting/upstreamTrustBundle.test.ts`

Expected: PASS, all cases.

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add src/runHosting/upstreamTrustBundle.ts tests/unit/runHosting/upstreamTrustBundle.test.ts
git commit -m "feat(runHosting): assemble the upstream trust bundle from public and ambient roots"
```

---

### Task 3: Render the validation context in envoy.yaml

**Files:**

- Modify: `src/envoyConfig.ts:95` (`buildTlsUpstreamCluster`) and its four callers at `:159`, `:325`, `:433`, `:573`, plus `generateEnvoyConfig` at `:904`
- Modify: `src/runHosting/buildConfig.ts:16`
- Test: `tests/unit/proxyConfig.test.ts`

**Interfaces:**

- Consumes: nothing at runtime; the container path is declared here.
- Produces: `UPSTREAM_TRUST_BUNDLE_CONTAINER_PATH = '/etc/envoy/ca/upstream-trust.pem'` exported from `src/envoyConfig.ts`. `BuildEnvoyConfigOptions` gains `verifyUpstreamOverrides?: boolean`. `writeEnvoyConfig` gains a 7th positional parameter `verifyUpstreamOverrides?: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/proxyConfig.test.ts`:

```typescript
describe('upstream certificate validation', () => {
  const terminatingAllowlist: Allowlist = {
    passthrough: [],
    claudeAuthenticated: ['api.anthropic.com:443'],
    githubAuthenticated: ['api.github.com:443'],
    codexAuthenticated: ['chatgpt.com:443'],
    authCandidate: ['auth-candidate.test:443'],
    blocked: [],
    warnings: [],
  };

  const tlsClusters = (config: any) =>
    config.static_resources.clusters.filter(
      (c: any) =>
        c.transport_socket?.typed_config?.['@type']?.endsWith('UpstreamTlsContext') === true,
    );

  it('gives every TLS-terminated cluster a trusted_ca and a DNS SAN matcher on its own SNI host', () => {
    const config = generateEnvoyConfig(terminatingAllowlist) as any;
    const clusters = tlsClusters(config);
    expect(clusters).toHaveLength(4);
    for (const cluster of clusters) {
      const tls = cluster.transport_socket.typed_config;
      const validation = tls.common_tls_context.validation_context;
      expect(validation.trusted_ca.filename).toBe(UPSTREAM_TRUST_BUNDLE_CONTAINER_PATH);
      expect(validation.match_typed_subject_alt_names).toEqual([
        { san_type: 'DNS', matcher: { exact: tls.sni } },
      ]);
      expect(validation.trust_chain_verification).toBeUndefined();
    }
  });

  it('never renders ACCEPT_UNTRUSTED when no overrides are configured', () => {
    const yaml = JSON.stringify(generateEnvoyConfig(terminatingAllowlist));
    expect(yaml).not.toContain('ACCEPT_UNTRUSTED');
  });

  it('keeps ACCEPT_UNTRUSTED for an override when verifyUpstreamOverrides is not set', () => {
    const config = generateEnvoyConfig(terminatingAllowlist, {
      overrides: [{ sniHost: 'api.anthropic.com', target: 'host.docker.internal:9999' }],
    }) as any;
    const cluster = tlsClusters(config).find(
      (c: any) => c.transport_socket.typed_config.sni === 'api.anthropic.com',
    );
    expect(cluster.transport_socket.typed_config.common_tls_context).toEqual({
      validation_context: { trust_chain_verification: 'ACCEPT_UNTRUSTED' },
    });
  });

  it('validates an override against the SNI host, not the override target, when opted in', () => {
    const config = generateEnvoyConfig(terminatingAllowlist, {
      overrides: [{ sniHost: 'api.anthropic.com', target: 'host.docker.internal:9999' }],
      verifyUpstreamOverrides: true,
    }) as any;
    const cluster = tlsClusters(config).find(
      (c: any) => c.transport_socket.typed_config.sni === 'api.anthropic.com',
    );
    const validation = cluster.transport_socket.typed_config.common_tls_context.validation_context;
    expect(validation.trusted_ca.filename).toBe(UPSTREAM_TRUST_BUNDLE_CONTAINER_PATH);
    expect(validation.match_typed_subject_alt_names).toEqual([
      { san_type: 'DNS', matcher: { exact: 'api.anthropic.com' } },
    ]);
  });

  it('leaves the MCP cluster cleartext', () => {
    const config = generateEnvoyConfig(terminatingAllowlist, {
      mcpServers: [{ hostname: 'mcp.test', port: 7000 }],
    }) as any;
    const mcp = config.static_resources.clusters.find((c: any) => c.name === 'cluster_mcp_mcp_test');
    expect(mcp.transport_socket).toBeUndefined();
  });
});
```

Add `UPSTREAM_TRUST_BUNDLE_CONTAINER_PATH` to the existing import block at the top of that file:

```typescript
import {
  generateEnvoyConfig,
  NO_AUTH_MARKER_HEADER,
  NO_AUTH_SENTINEL_VALUE,
  NO_ACCOUNT_ID_MARKER_HEADER,
  NO_ACCOUNT_ID_SENTINEL_VALUE,
  AUTH_POST_FILTER_LUA,
  UPSTREAM_TRUST_BUNDLE_CONTAINER_PATH,
} from '../../src/envoyConfig';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/proxyConfig.test.ts`

Expected: FAIL — `UPSTREAM_TRUST_BUNDLE_CONTAINER_PATH` is not exported, and `validation_context` is undefined on the non-override clusters.

- [ ] **Step 3: Add the constant and rewrite the cluster builder**

In `src/envoyConfig.ts`, add the constant next to the other exported constants near the top:

```typescript
/** Where docker-compose.yml's `./ca:/etc/envoy/ca:ro` mount exposes the assembled bundle. */
export const UPSTREAM_TRUST_BUNDLE_CONTAINER_PATH = '/etc/envoy/ca/upstream-trust.pem';
```

Add the option to `BuildEnvoyConfigOptions`:

```typescript
  /** Test-only. Render override clusters with the production validation context
   * instead of ACCEPT_UNTRUSTED. Set by run-hosting's --verify-upstream-overrides. */
  verifyUpstreamOverrides?: boolean;
```

Replace `buildTlsUpstreamCluster` (currently at `:95`):

```typescript
function buildTlsUpstreamCluster(
  clusterName: string,
  sniHost: string,
  portStr: string,
  override: UpstreamOverride | undefined,
  verifyOverrides: boolean,
) {
  const [upstreamHost, upstreamPortStr] = override
    ? override.target.split(':')
    : [sniHost, portStr];
  // trust_chain_verification is omitted on the validating branch: VERIFY_TRUST_CHAIN
  // is already Envoy's default. The SAN matcher keys off sniHost, never the
  // override target, because that is the name the origin must actually prove.
  const commonTlsContext =
    override && !verifyOverrides
      ? { validation_context: { trust_chain_verification: 'ACCEPT_UNTRUSTED' } }
      : {
          validation_context: {
            trusted_ca: { filename: UPSTREAM_TRUST_BUNDLE_CONTAINER_PATH },
            match_typed_subject_alt_names: [{ san_type: 'DNS', matcher: { exact: sniHost } }],
          },
        };
  return {
    name: clusterName,
    type: 'STRICT_DNS',
    dns_lookup_family: 'V4_ONLY',
    lb_policy: 'ROUND_ROBIN',
    load_assignment: {
      cluster_name: clusterName,
      endpoints: [
        {
          lb_endpoints: [
            {
              endpoint: {
                address: {
                  socket_address: { address: upstreamHost, port_value: Number(upstreamPortStr) },
                },
              },
            },
          ],
        },
      ],
    },
    transport_socket: {
      name: 'envoy.transport_sockets.tls',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext',
        sni: sniHost,
        common_tls_context: commonTlsContext,
      },
    },
  };
}
```

- [ ] **Step 4: Thread `verifyOverrides` through the four builders**

Each of the four builders gains a trailing `verifyOverrides: boolean` parameter and passes it to `buildTlsUpstreamCluster`. Make exactly these edits:

`buildAuthCandidateEntry` (`:159`):

```typescript
function buildAuthCandidateEntry(
  entry: string,
  overrides: UpstreamOverride[],
  verifyOverrides: boolean,
) {
```

and at `:218`:

```typescript
  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override, verifyOverrides);
```

`buildGithubEntry` (`:325`):

```typescript
function buildGithubEntry(
  entry: string,
  overrides: UpstreamOverride[],
  sdsResource: string,
  sdsFile: string,
  gateSource: string,
  verifyOverrides: boolean,
) {
```

and at `:428`:

```typescript
  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override, verifyOverrides);
```

`buildClaudeEntry` (`:433`):

```typescript
function buildClaudeEntry(
  entry: string,
  overrides: UpstreamOverride[],
  verifyOverrides: boolean,
) {
```

and at `:536`:

```typescript
  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override, verifyOverrides);
```

`buildCodexEntry` (`:573`):

```typescript
function buildCodexEntry(
  entry: string,
  overrides: UpstreamOverride[],
  verifyOverrides: boolean,
) {
```

and at `:698`:

```typescript
  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override, verifyOverrides);
```

Then in `generateEnvoyConfig` (`:904`), read the option and pass it at each of the four call sites:

```typescript
  const overrides = options.overrides ?? [];
  const skipAllowList = options.skipAllowList ?? false;
  const verifyOverrides = options.verifyUpstreamOverrides ?? false;
  const adminPortValue =
    options.fault === 'crash-config' ? 70000 : options.fault === 'never-ready' ? 9902 : 9901;

  const claudeBuilt = allowlist.claudeAuthenticated
    .filter((e) => e.endsWith(':443'))
    .map((e) => buildClaudeEntry(e, overrides, verifyOverrides));
  const codexBuilt = allowlist.codexAuthenticated
    .filter((e) => e.endsWith(':443'))
    .map((e) => buildCodexEntry(e, overrides, verifyOverrides));
  const authCandidateBuilt = allowlist.authCandidate
    .filter((e) => e.endsWith(':443'))
    .map((e) => buildAuthCandidateEntry(e, overrides, verifyOverrides));
  const githubBuilt = allowlist.githubAuthenticated
    .filter((e) => e.endsWith(':443'))
    .map((e) => {
      const host = e.split(':')[0];
      const cfg = GITHUB_INJECTION[host];
      return cfg
        ? buildGithubEntry(e, overrides, cfg.sdsResource, cfg.sdsFile, cfg.gate, verifyOverrides)
        : null;
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
```

- [ ] **Step 5: Thread it through `writeEnvoyConfig`**

Replace `src/runHosting/buildConfig.ts` in full:

```typescript
import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import {
  generateEnvoyConfig,
  type UpstreamOverride,
  type InjectFault,
  type McpServerUpstream,
} from '../envoyConfig';
import type { Allowlist } from '../allowlist';

/**
 * Render envoy.yaml for an already-parsed (and already-validated) allowlist and
 * write it to outputPath. Surfacing `allowlist.warnings` is the caller's job.
 * `fault` is a test-only render mutation; when omitted the output is unchanged.
 * `verifyUpstreamOverrides` is likewise test-only: it opts override clusters
 * into the production validation context instead of ACCEPT_UNTRUSTED.
 */
export function writeEnvoyConfig(
  allowlist: Allowlist,
  outputPath: string,
  overrides: UpstreamOverride[],
  fault?: InjectFault,
  mcpServers?: McpServerUpstream[],
  skipAllowList?: boolean,
  verifyUpstreamOverrides?: boolean,
): void {
  writeFileSync(
    outputPath,
    stringify(
      generateEnvoyConfig(allowlist, {
        overrides,
        fault,
        mcpServers,
        skipAllowList,
        verifyUpstreamOverrides,
      }),
    ),
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/proxyConfig.test.ts tests/unit/proxyConfigWriting.test.ts`

Expected: PASS. If `proxyConfigWriting.test.ts` asserts an exact argument list for `writeEnvoyConfig`, update it to include the new trailing parameter.

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add src/envoyConfig.ts src/runHosting/buildConfig.ts tests/unit/proxyConfig.test.ts tests/unit/proxyConfigWriting.test.ts
git commit -m "feat(envoyConfig): validate upstream certificates by chain and SAN"
```

---

### Task 4: Assemble the bundle at run-hosting startup

**Files:**

- Modify: `src/envPaths.ts` (interface + `envPaths()`)
- Modify: `src/commands/runHosting.ts` (`RunHostingOptions:46-60`, the flag block at `:131-141`, the startup block after the CA check at `:180-187`, and the `buildConfig` dep at `:306-313`)
- Test: `tests/unit/envPaths.test.ts`
- Test: `tests/cli/cli.test.ts`

**Interfaces:**

- Consumes: `enumerateHostTrustedRoots` / `HostTrustStoreError` (Task 1); `assembleUpstreamTrustBundle`, `readPublicRootProgram`, `parseExtraCaPem`, `formatTrustBundleSummary`, `writeUpstreamTrustBundle`, `UpstreamTrustBundleError` (Task 2); `writeEnvoyConfig`'s 7th parameter (Task 3).
- Produces: `EnvPaths.upstreamTrustBundle: string` at `.susentorno/proxy/ca/upstream-trust.pem`. The CLI flag `--verify-upstream-overrides <caPath>`, surfaced on `RunHostingOptions` as `verifyUpstreamOverrides?: string`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/envPaths.test.ts` (inside its existing top-level `describe`, matching the surrounding style):

```typescript
  it('places the upstream trust bundle alongside the proxy CA material', () => {
    const paths = envPaths('C:\\work');
    expect(paths.upstreamTrustBundle).toBe(join('C:\\work', '.susentorno', 'proxy', 'ca', 'upstream-trust.pem'));
  });
```

Append to `tests/cli/cli.test.ts`, inside `describe('CLI interface')`:

```typescript
  it('lists --verify-upstream-overrides in run-hosting help', async () => {
    const { stdout } = await execa('node', [cliPath, 'run-hosting', '--help']);
    expect(stdout).toContain('--verify-upstream-overrides');
  });

  it('run-hosting refuses a --verify-upstream-overrides file that does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
      const { exitCode, stderr, stdout } = await execa(
        'node',
        [
          cliPath,
          'run-hosting',
          '--no-refresh',
          '--no-forward',
          '--verify-upstream-overrides',
          join(dir, 'nope.pem'),
        ],
        { cwd: dir, reject: false },
      );
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain('--verify-upstream-overrides');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('run-hosting refuses a --verify-upstream-overrides file that is not a certificate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
    try {
      await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
        { cwd: dir },
      );
      await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
      const junk = join(dir, 'junk.pem');
      writeFileSync(junk, 'this is not a certificate\n');
      const { exitCode, stderr, stdout } = await execa(
        'node',
        [cliPath, 'run-hosting', '--no-refresh', '--no-forward', '--verify-upstream-overrides', junk],
        { cwd: dir, reject: false },
      );
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain('not a parseable PEM certificate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
```

Add `writeFileSync` to that file's `node:fs` import:

```typescript
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/envPaths.test.ts`

Expected: FAIL — `paths.upstreamTrustBundle` is `undefined`.

- [ ] **Step 3: Add the path**

In `src/envPaths.ts`, add to the `EnvPaths` interface immediately after `caLeafKey: string;`:

```typescript
  upstreamTrustBundle: string;
```

and to the returned object in `envPaths()`, immediately after the `caLeafKey` entry:

```typescript
    upstreamTrustBundle: join(proxy, 'ca', 'upstream-trust.pem'),
```

- [ ] **Step 4: Add the flag and the startup block**

In `src/commands/runHosting.ts`, add to the imports:

```typescript
import { enumerateHostTrustedRoots, HostTrustStoreError } from '../guestSetup/hostTrustStore';
import { createRealPowerShellExec } from '../guestSetup/powerShellExec';
import {
  assembleUpstreamTrustBundle,
  formatTrustBundleSummary,
  parseExtraCaPem,
  readPublicRootProgram,
  UpstreamTrustBundleError,
  writeUpstreamTrustBundle,
  type UpstreamTrustBundle,
} from '../runHosting/upstreamTrustBundle';
```

Add to `RunHostingOptions` (after `injectFault?: InjectFault;`):

```typescript
  verifyUpstreamOverrides?: string;
```

Add the flag immediately after the `--inject-fault` option block (`:137-140`):

```typescript
    .option(
      '--verify-upstream-overrides <caPath>',
      'validate --upstream-override upstreams against this CA instead of accepting any ' +
        'certificate, and add it to the upstream trust bundle (test use only)',
    )
```

Insert this block immediately after the existing proxy-CA existence check (which ends with the `return;` at `:187`) and before `const secretPath = options.secret ?? paths.sdsSecret;`:

```typescript
        // Assembled once per process, before anything binds: envoy.yaml names a
        // constant trusted_ca filename, so policy reloads never re-enumerate.
        let extraCaPem: string | undefined;
        let bundle: UpstreamTrustBundle;
        try {
          if (options.verifyUpstreamOverrides !== undefined) {
            extraCaPem = parseExtraCaPem(
              readFileSync(options.verifyUpstreamOverrides, 'utf8'),
            );
          }
          const snapshot = await enumerateHostTrustedRoots(createRealPowerShellExec());
          bundle = assembleUpstreamTrustBundle({
            publicRoots: readPublicRootProgram(),
            hostRoots: snapshot.roots,
            disallowedSha256: snapshot.disallowedSha256,
            extraCaPem,
          });
          writeUpstreamTrustBundle(paths.upstreamTrustBundle, bundle);
        } catch (err) {
          // Do NOT set alertOnNonzeroExit = false here. These are startup
          // refusals like any other, and the abnormal-exit alert should fire.
          if (err instanceof HostTrustStoreError || err instanceof UpstreamTrustBundleError) {
            const prefix =
              options.verifyUpstreamOverrides !== undefined && err instanceof UpstreamTrustBundleError
                ? 'run-hosting: --verify-upstream-overrides: '
                : 'run-hosting: ';
            console.error(`${prefix}${err.message}`);
            process.exitCode = 1;
            return;
          }
          if ((err as NodeJS.ErrnoException)?.code !== undefined) {
            console.error(
              `run-hosting: --verify-upstream-overrides: could not read ${options.verifyUpstreamOverrides}: ${(err as Error).message}`,
            );
            process.exitCode = 1;
            return;
          }
          throw err;
        }
        console.log(`run-hosting: ${formatTrustBundleSummary(bundle)}`);

        // "(test use only)" in help text is a convention; this is an observable
        // fact about what is currently unprotected.
        if (options.verifyUpstreamOverrides === undefined && options.upstreamOverride.length > 0) {
          console.warn(
            'run-hosting: WARNING — upstream certificate validation is DISABLED for: ' +
              options.upstreamOverride.map((o) => o.sniHost).join(', '),
          );
        }
```

Finally, pass the flag through to the renderer — replace the `buildConfig` dep at `:306-313`:

```typescript
          buildConfig: (allowlist, mcpServersWithPorts) =>
            writeEnvoyConfig(
              allowlist,
              paths.envoyConfig,
              options.upstreamOverride,
              options.injectFault,
              mcpServersWithPorts,
              options.skipAllowList,
              options.verifyUpstreamOverrides !== undefined,
            ),
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run tests/unit/envPaths.test.ts
pnpm build && pnpm test:cli
```

Expected: both PASS. The CLI tier needs `pnpm build` first because it drives `dist/cli.js`.

- [ ] **Step 6: Verify the bundle is actually produced, by hand**

```bash
pnpm build
node dist/cli.js run-hosting --help
```

Expected: `--verify-upstream-overrides <caPath>` appears in the help output. This is a cheap check that the flag registered before the proxy-stack tier depends on it.

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add src/envPaths.ts src/commands/runHosting.ts tests/unit/envPaths.test.ts tests/cli/cli.test.ts
git commit -m "feat(run-hosting): assemble and write the upstream trust bundle at startup"
```

---

### Task 5: Teach the mock upstream to serve a supplied certificate and count connections

The current mock serves a hardcoded self-signed cert with CN `mock-upstream` and **no SANs at all** (`tests/proxy-stack/mockUpstream.ts:17-31`), so it would fail SAN matching even if it were trusted. It also records only completed HTTP requests, which means "received nothing" cannot distinguish a rejected handshake from a connection that never arrived.

**Files:**

- Modify: `tests/proxy-stack/mockUpstream.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `startMockUpstream(options?: MockUpstreamOptions): Promise<MockUpstream>` where `MockUpstreamOptions { key?: string; cert?: string }`. `MockUpstream` gains `readonly connectionCount: number`. All existing fields and the no-argument call signature are unchanged, so the four existing suites keep compiling untouched.

- [ ] **Step 1: Make the change**

Replace `startMockUpstream` and the `MockUpstream` interface in `tests/proxy-stack/mockUpstream.ts`. `generateSelfSignedCert` stays exactly as it is and remains the default.

```typescript
export interface MockUpstreamOptions {
  /** PEM key/cert to serve instead of the built-in self-signed pair. Both or neither. */
  key?: string;
  cert?: string;
}

export interface MockUpstream {
  port: number;
  server: Server;
  receivedAuthorizationHeaders: string[];
  receivedUpgradeAuthorizationHeaders: string[];
  /** Full headers object for every request, in order — for asserting on headers
   * other than Authorization (e.g. that no internal marker header ever leaks). */
  receivedHeaders: IncomingHttpHeaders[];
  /** Same as receivedHeaders, but for WebSocket upgrade requests. */
  receivedUpgradeHeaders: IncomingHttpHeaders[];
  /**
   * TCP connections accepted, counted on the `connection` event — which fires
   * before the TLS handshake. Lets a test distinguish "Envoy dialled us and the
   * handshake was rejected" from "Envoy never reached us at all", which the
   * request counters alone cannot do.
   */
  readonly connectionCount: number;
}

export function startMockUpstream(options: MockUpstreamOptions = {}): Promise<MockUpstream> {
  const pems =
    options.key !== undefined && options.cert !== undefined
      ? { key: options.key, cert: options.cert }
      : generateSelfSignedCert();
  const receivedAuthorizationHeaders: string[] = [];
  const receivedHeaders: IncomingHttpHeaders[] = [];
  const state = { connections: 0 };

  const server = createServer({ key: pems.key, cert: pems.cert }, (req, res) => {
    receivedAuthorizationHeaders.push(req.headers.authorization ?? '');
    receivedHeaders.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('mock upstream ok');
  });

  server.on('connection', () => {
    state.connections++;
  });

  const receivedUpgradeAuthorizationHeaders: string[] = [];
  const receivedUpgradeHeaders: IncomingHttpHeaders[] = [];
  server.on('upgrade', (req, socket) => {
    receivedUpgradeAuthorizationHeaders.push(req.headers.authorization ?? '');
    receivedUpgradeHeaders.push(req.headers);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('failed to bind mock upstream');
      }
      resolve({
        port: address.port,
        server,
        receivedAuthorizationHeaders,
        receivedUpgradeAuthorizationHeaders,
        receivedHeaders,
        receivedUpgradeHeaders,
        get connectionCount() {
          return state.connections;
        },
      });
    });
  });
}
```

- [ ] **Step 2: Verify the existing suites still compile and pass**

```bash
pnpm typecheck
pnpm build && pnpm vitest run --config vitest.proxy-stack.config.ts tests/proxy-stack/githubInjection.test.ts
```

Expected: typecheck clean; `githubInjection` PASS. This is the regression gate for the mock change — that suite calls `startMockUpstream()` with no arguments and must be unaffected.

- [ ] **Step 3: Lint and commit**

```bash
pnpm lint && pnpm format:check
git add tests/proxy-stack/mockUpstream.ts
git commit -m "test(mockUpstream): allow a supplied certificate and count connections"
```

---

### Task 6: The proxy-stack upstream validation suite

Five credential-injected destinations, five mock upstreams, one `run-hosting` process. All five sit under `#pragma claude authenticated` so the same real credential is injected into each, which is what makes "the mock received nothing" a statement about credential disclosure rather than about traffic in general.

**Files:**

- Create: `tests/proxy-stack/upstreamValidation.test.ts`

**Interfaces:**

- Consumes: `startMockUpstream({ key, cert })` and `connectionCount` (Task 5); `--verify-upstream-overrides` (Task 4); the rendered validation context (Task 3). Uses `generateRootCa()` and `generateLeaf(caCertPem, caKeyPem, sans)` from `src/ca.ts`.
- Produces: nothing consumed by later tasks.

Ports 18451 / 18188 are unused by the other proxy-stack suites (18443/18080, 18447/18184, 18449/18186, 18450/18187, 18543/18180, 18545/18182).

- [ ] **Step 1: Write the failing test**

Create `tests/proxy-stack/upstreamValidation.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { killProcessTree } from '../../src/runHosting/killProcessTree';
import { rmEnvRoot } from '../rmEnvRoot';
import { generateRootCa, generateLeaf } from '../../src/ca';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';
import { envParent, envRoot } from '../testEnvRoot';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const proxyDir = join(envRoot, 'proxy');

// Distinct from every other proxy-stack suite's ports.
const HTTPS_PORT = 18451;
const HTTP_PORT = 18188;
const envoyEnv = { ENVOY_HTTPS_PORT: String(HTTPS_PORT), ENVOY_HTTP_PORT: String(HTTP_PORT) };

const PLACEHOLDER_AUTH = 'Bearer sk-ant-oat-susentorno-PLACEHOLDER';
const REAL_TOKEN = 'susentorno-upstream-validation-real-token';
const REAL_AUTH = `Bearer ${REAL_TOKEN}`;

const GOOD = 'claude-good.test';
const WILDCARD = 'sub.claude-wild.test';
const BAD_NAME = 'claude-badname.test';
const UNTRUSTED = 'claude-untrusted.test';
const EXPIRED = 'claude-expired.test';
const ALL_HOSTS = [GOOD, WILDCARD, BAD_NAME, UNTRUSTED, EXPIRED];

let mocks: Record<string, MockUpstream>;
let tempDir: string;
let credentialsPath: string;
let codexCredentialsPath: string;
let caCertPem: string;
let throwawayCaPath: string;
let proxyProc: ResultPromise | null = null;
const stdoutLines: string[] = [];

/**
 * A leaf whose notAfter is already in the past. src/ca.ts's validityDates() is
 * private and takes no override, so this one certificate is minted directly
 * with node-forge — the same library generateLeaf uses internally.
 */
function mintExpiredLeaf(
  caCertPem: string,
  caKeyPem: string,
  sans: string[],
): { leafCertPem: string; leafKeyPem: string } {
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date(Date.now() - 60 * 86_400_000);
  cert.validity.notAfter = new Date(Date.now() - 86_400_000);
  cert.setSubject([{ name: 'commonName', value: 'expired-leaf' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: sans.map((value) => ({ type: 2, value })) },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    leafCertPem: forge.pki.certificateToPem(cert),
    leafKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** A self-signed server cert carrying real SANs — chains to nothing in the bundle. */
function mintSelfSigned(sans: string[]): { leafCertPem: string; leafKeyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '03';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: sans[0] }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: sans.map((value) => ({ type: 2, value })) },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    leafCertPem: forge.pki.certificateToPem(cert),
    leafKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

async function waitForLine(needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stdoutLines.some((l) => l.includes(needle))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for '${needle}'\n--- output ---\n${stdoutLines.join('\n')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function requestThrough(servername: string): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername,
        ca: caCertPem,
        path: '/',
        headers: { authorization: PLACEHOLDER_AUTH },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const throwaway = generateRootCa();

  // One leaf per destination. Only the SAN set and the issuer differ.
  const goodLeaf = generateLeaf(throwaway.caCertPem, throwaway.caKeyPem, [GOOD]);
  const wildLeaf = generateLeaf(throwaway.caCertPem, throwaway.caKeyPem, ['*.claude-wild.test']);
  const badNameLeaf = generateLeaf(throwaway.caCertPem, throwaway.caKeyPem, ['somewhere-else.test']);
  const untrustedLeaf = mintSelfSigned([UNTRUSTED]);
  const expiredLeaf = mintExpiredLeaf(throwaway.caCertPem, throwaway.caKeyPem, [EXPIRED]);

  mocks = {
    [GOOD]: await startMockUpstream({ key: goodLeaf.leafKeyPem, cert: goodLeaf.leafCertPem }),
    [WILDCARD]: await startMockUpstream({ key: wildLeaf.leafKeyPem, cert: wildLeaf.leafCertPem }),
    [BAD_NAME]: await startMockUpstream({
      key: badNameLeaf.leafKeyPem,
      cert: badNameLeaf.leafCertPem,
    }),
    [UNTRUSTED]: await startMockUpstream({
      key: untrustedLeaf.leafKeyPem,
      cert: untrustedLeaf.leafCertPem,
    }),
    [EXPIRED]: await startMockUpstream({
      key: expiredLeaf.leafKeyPem,
      cert: expiredLeaf.leafCertPem,
    }),
  };

  tempDir = mkdtempSync(join(tmpdir(), 'upstream-validation-'));
  credentialsPath = join(tempDir, '.credentials.json');
  codexCredentialsPath = join(tempDir, 'auth.json');
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: REAL_TOKEN, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    }),
  );
  writeFileSync(codexCredentialsPath, readFileSync(authFixture, 'utf8'));

  throwawayCaPath = join(tempDir, 'throwaway-ca.pem');
  writeFileSync(throwawayCaPath, throwaway.caCertPem);

  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );

  // The auth list must be written BEFORE generate-ca so the downstream leaf's
  // SANs cover all five destinations.
  writeFileSync(join(proxyDir, 'allow-list.txt'), '');
  writeFileSync(
    join(proxyDir, 'auth-list.txt'),
    ['#pragma claude authenticated', ...ALL_HOSTS.map((h) => `${h}:443`), ''].join('\n'),
  );
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });

  proxyProc = execa(
    'node',
    [
      cliPath,
      'run-hosting',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
      '--codex-credentials',
      codexCredentialsPath,
      '--verify-upstream-overrides',
      throwawayCaPath,
      ...ALL_HOSTS.flatMap((h) => [
        '--upstream-override',
        `${h}=host.docker.internal:${mocks[h].port}`,
      ]),
    ],
    { cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => stdoutLines.push(line));
  }

  await waitForLine('serving the current token', 60000);
  caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
}, 180000);

afterAll(async () => {
  if (proxyProc?.pid !== undefined) {
    await killProcessTree(proxyProc.pid, 'SIGINT');
  }
  try {
    await proxyProc;
  } catch {
    // ignore kill/non-zero
  }
  await execa('docker', ['compose', 'down'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
    reject: false,
  });
  for (const host of ALL_HOSTS) {
    await stopMockUpstream(mocks[host]);
  }
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('upstream trust bundle assembly', () => {
  it('reports the bundle it assembled at startup', () => {
    expect(stdoutLines.some((l) => l.includes('upstream trust bundle:'))).toBe(true);
  });
});

describe('accepted upstream certificates', () => {
  it('connects and injects the real credential when the chain and SAN both match', async () => {
    const before = mocks[GOOD].receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(GOOD);
    expect(statusCode).toBe(200);
    expect(mocks[GOOD].receivedAuthorizationHeaders.slice(before)).toEqual([REAL_AUTH]);
  });

  it('accepts a wildcard SAN covering the SNI host', async () => {
    const before = mocks[WILDCARD].receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(WILDCARD);
    expect(statusCode).toBe(200);
    expect(mocks[WILDCARD].receivedAuthorizationHeaders.slice(before)).toEqual([REAL_AUTH]);
  });
});

describe('rejected upstream certificates', () => {
  // Each case asserts BOTH that the credential never crossed AND that the mock
  // saw a connection attempt. Non-disclosure alone would also pass if Envoy had
  // simply never dialled the mock — a wrong port would look identical.
  it('refuses a valid chain whose SAN does not cover the SNI host', async () => {
    const { statusCode } = await requestThrough(BAD_NAME);
    expect(statusCode).toBe(503);
    expect(mocks[BAD_NAME].receivedAuthorizationHeaders).toEqual([]);
    expect(mocks[BAD_NAME].connectionCount).toBeGreaterThan(0);
  });

  it('refuses a self-signed certificate even when its SAN matches', async () => {
    const { statusCode } = await requestThrough(UNTRUSTED);
    expect(statusCode).toBe(503);
    expect(mocks[UNTRUSTED].receivedAuthorizationHeaders).toEqual([]);
    expect(mocks[UNTRUSTED].connectionCount).toBeGreaterThan(0);
  });

  it('refuses an expired certificate from a trusted issuer', async () => {
    const { statusCode } = await requestThrough(EXPIRED);
    expect(statusCode).toBe(503);
    expect(mocks[EXPIRED].receivedAuthorizationHeaders).toEqual([]);
    expect(mocks[EXPIRED].connectionCount).toBeGreaterThan(0);
  });

  it('logs the refusal on the access log line for the destination', async () => {
    await requestThrough(UNTRUSTED);
    await waitForLine('CFGM|', 10000);
    const line = stdoutLines.find((l) => l.includes('CFGM|') && l.includes(UNTRUSTED));
    expect(line).toBeDefined();
    expect(line).toContain('503');
  });
});
```

- [ ] **Step 2: Run the suite to verify it fails for the right reason**

```bash
pnpm build
pnpm vitest run --config vitest.proxy-stack.config.ts tests/proxy-stack/upstreamValidation.test.ts
```

Expected before Tasks 3-5 are complete: FAIL. With all prior tasks complete, this should PASS. If the accepted cases return 503, read the `CFGM|` lines in the failure output — `RESPONSE_CODE_DETAILS` carries Envoy's TLS error and will name the mismatch.

- [ ] **Step 3: Confirm the whole proxy-stack tier is green**

Run: `pnpm test:proxy-stack`

Expected: PASS for every file. The tier runs serially (`fileParallelism: false`), so this also confirms the new suite's ports and its `docker compose down` do not collide with the others.

- [ ] **Step 4: Lint and commit**

```bash
pnpm lint && pnpm format:check
git add tests/proxy-stack/upstreamValidation.test.ts
git commit -m "test(proxy-stack): prove upstream validation accepts good certs and refuses bad ones"
```

---

### Task 7: Records — ADR, glossary, diagnostics, and supersession

**Files:**

- Create: `docs/adr/0026-validate-upstream-certificates-against-ambient-trust.md`
- Modify: `CONTEXT.md` (Network policy section)
- Modify: `diagnostics.md` (after the "Watching proxy traffic" section)
- Modify: `docs/honist-v/briefs/2026-08-16-ambient-tls-trust-propagation-brief.md` (remove the superseded section)
- Modify: `docs/honist-v/specs/2026-08-16-ambient-tls-trust-auto-detection-design.md` (point the deferral at this work)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0026-validate-upstream-certificates-against-ambient-trust.md`:

```markdown
# Validate upstream certificates against the public root program plus the host's ambient trust

Every TLS-terminated upstream — the github, claude, codex, and auth-candidate clusters — is verified against a bundle assembled at `run-hosting` startup from Node's bundled public root program (`tls.rootCertificates`) **and** the host's own trusted roots, with `match_typed_subject_alt_names` requiring a DNS SAN matching the cluster's configured SNI host. Previously `buildTlsUpstreamCluster` emitted `common_tls_context: {}`, which disables verification entirely, so the proxy would inject a real host credential into a connection to any upstream that answered — then re-wrap the response in its own CA, which every guest trusts, making the substitution undetectable from inside the guest.

## Considered Options

- **The Envoy container's own `/etc/ssl/certs/ca-certificates.crt`.** No assembly needed, but it contains no ambient interception CA, so it breaks susentorno on any host behind a corporate middlebox — including the nested case where the host is itself a susentorno guest.
- **The Windows root store alone.** Measured on a real host: 58 roots against Node's 118. Windows ships a subset and fetches the rest on demand via CTL auto-update, which Envoy cannot trigger, so origins whose root has not been cached yet would fail intermittently and per-machine.
- **Chain verification without SAN matching.** Rejects self-signed and attacker-minted certificates, but still accepts a validly issued certificate for an unrelated domain — so anyone controlling any domain could still collect the injected credential. Envoy's own documentation states SAN matching must be used together with `trusted_ca`.

## Consequences

- The security property is now "a certificate **for the configured DNS name**, issued by **any CA in Node's bundled root program or the host's trust store**" — not unqualified validation. **The integrity of the host's trust store is therefore a security boundary**: any enterprise, interception, or otherwise ambient CA the host trusts can still mint a certificate this proxy accepts for a credential-injected destination. That is the deliberate price of working behind a middlebox, and it inherits an exposure the host already has, since the host's own direct use of these same credentials depends on the same store.
- The bundle reuses `enumerateHostTrustedRoots`, built for guest ambient-trust propagation ([[ambient-tls-trust-auto-detection]] in the specs), which is why turning validation on did not require a second trust-detection mechanism.
- `run-hosting` gains a PowerShell call but **not** an elevation requirement: `X509Store.Open('ReadOnly')` on `LocalMachine\Root` works with a non-elevated token.
- Assembly happens once per `run-hosting` process. `envoy.yaml` names a constant `trusted_ca` filename, so policy reloads and blue/green swaps re-read the file without re-enumerating; picking up a host trust change requires restarting `run-hosting`.
- Leaf revocation is **not** checked — no CRL, no OCSP. "Validated" here means chain plus name, nothing more.
- The Windows `Disallowed` cross-check applied to both sources is **best-effort and cannot be made otherwise**: `X509Store.Open('ReadOnly')` returns `count=0` for a bogus store name rather than throwing, so "the distrust store is empty" and "we did not really read it" are indistinguishable. Failing closed on a thrown error is still worth doing, but the filter is not a guarantee.
- `--upstream-override` still renders `ACCEPT_UNTRUSTED` unless `--verify-upstream-overrides` is passed, so the existing proxy-stack suites keep working; `run-hosting` logs a warning naming any destination left unverified.
- Passthrough destinations are unaffected ([[transparent-interception-and-network-isolation-boundary]]): they are `tcp_proxy`, so the guest validates end to end itself. The downstream half of the TLS story is unchanged ([[root-ca-plus-derived-leaf]]), as is what is at stake on the terminated hop ([[credential-injection-at-proxy]]).
```

- [ ] **Step 2: Add the glossary term**

In `CONTEXT.md`, add to the **Network policy** section, immediately after the **Proxy stack** entry:

```markdown
**Upstream trust bundle**: The assembled set of certificate authorities the proxy stack validates terminated upstream connections against, combining the public root program with the host's ambient trust. _Avoid_: CA bundle, trusted_ca, root bundle
```

- [ ] **Step 3: Document the failure mode**

In `diagnostics.md`, add a new section immediately after the "Watching proxy traffic" section:

```markdown
## A terminated destination returns 503

The proxy verifies every TLS-terminated upstream's certificate — both that it chains to the **upstream trust bundle** and that it carries a DNS SAN matching the destination hostname. A failure surfaces to the guest as a 503, and the reason is on the `CFGM|` access-log line: `%RESPONSE_CODE_DETAILS%` carries Envoy's TLS error text and `%RESPONSE_FLAGS%` shows the upstream failure.

Two causes are far more likely than the rest:

- **The origin's certificate does not cover the name being dialled.** Check the SANs the origin actually serves against the hostname in `auth-list.txt`.
- **An ambient interception CA never reached the bundle.** On a machine behind a TLS-intercepting proxy, the interceptor's CA must be in the host's trust store for the proxy to accept it. Compare the ambient count on `run-hosting`'s startup line — `upstream trust bundle: N public roots (node vX) + M ambient = ...` — against expectation. `M` of 0 on a machine you know is intercepted means the CA is not in `LocalMachine\Root` or `CurrentUser\Root` where the enumeration looks.
```

- [ ] **Step 4: Remove the superseded brief section**

In `docs/honist-v/briefs/2026-08-16-ambient-tls-trust-propagation-brief.md`, delete the entire section beginning `## Split this out: Envoy does not validate upstream certificates` up to (but not including) `## Generalisation`. In its place put:

```markdown
## Split out: Envoy does not validate upstream certificates

Done. Designed in
`docs/honist-v/specs/2026-08-17-envoy-upstream-certificate-validation-design.md`
and recorded as
[ADR-0026](../../adr/0026-validate-upstream-certificates-against-ambient-trust.md).
```

- [ ] **Step 5: Close the deferral in the sibling spec**

In `docs/honist-v/specs/2026-08-16-ambient-tls-trust-auto-detection-design.md`, replace the body of the "Follow-up work (explicitly deferred)" section's single bullet with:

```markdown
- **Envoy upstream certificate validation.** No longer deferred — designed in
  `docs/honist-v/specs/2026-08-17-envoy-upstream-certificate-validation-design.md`,
  which consumes `enumerateHostTrustedRoots`'s output as this spec anticipated.
```

- [ ] **Step 6: Verify formatting and commit**

```bash
pnpm format:check
git add docs/adr/0026-validate-upstream-certificates-against-ambient-trust.md CONTEXT.md diagnostics.md docs/honist-v/briefs/2026-08-16-ambient-tls-trust-propagation-brief.md docs/honist-v/specs/2026-08-16-ambient-tls-trust-auto-detection-design.md
git commit -m "docs: record upstream certificate validation as ADR-0026"
```

---

## Final verification

- [ ] **Run the full pipeline**

Run: `pnpm test`

Expected: PASS through formatting, lint, typecheck, unit, build, cli, host-network, proxy-stack, and guest tiers. The guest tier needs an elevated shell, Hyper-V, Docker, and `ssh-agent` (see `development.md`) and takes minutes.

The guest tier matters here specifically because Task 1 changes `hostTrustStore.ts`, which `setup-guest-unix` depends on through `propagateAmbientTrust`. `tests/guest/` contains the real-guest ambient-trust coverage added in commit `0cf2b19`; it must stay green, and it is the only place the fail-closed Disallowed change is exercised against a real Windows store.
