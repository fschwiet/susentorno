# Ambient TLS trust auto-detection for setup-guest-unix

## Problem

Two briefs describe the same problem at different altitudes:

- `docs/honist-v/briefs/2026-08-16-nested-guest-tls-interception.md` is the general
  write-up: a nested VM inherits its host's TLS-intercepting proxy routing without
  inheriting the trust that makes it workable, so a subset of HTTPS hosts fails
  certificate verification inside the VM while everything else works — a
  confusing partial failure.
- `docs/honist-v/briefs/2026-08-16-ambient-tls-trust-propagation-brief.md` is the
  susentorno-specific instance: `setup-guest-unix` provisions a guest from a
  pristine base image, and on a machine that itself sits behind a
  TLS-intercepting proxy — a corporate middlebox, a CI runner behind inspection,
  or another susentorno installation — the guest's pre-scripts fail exactly this
  way. It was hit for real building the Hyper-V guest test tier and worked around
  locally by moving `github.com`/`api.github.com` to passthrough, which the brief
  itself calls an expedient, not a fix.

That brief proposed a manual fix: an `--extra-ca <path>` flag on `setup-guest-unix`,
with a harness-side stopgap already landed (`tests/guest/extraCas.ts`,
`SUSENTORNO_TEST_EXTRA_CA`) that requires a developer to hand-export the
interceptor's CA from `Cert:\LocalMachine\Root` and point an environment variable
at it. The brief flagged that manual step as something that "should not survive"
and deferred automatic detection because "auto-detection on Windows needs care to
avoid sweeping in unrelated enterprise roots."

This spec replaces the manual-flag proposal with automatic detection, worked out
in detail below, and removes the harness-side stopgap entirely.

## Non-goals

- **Enabling Envoy upstream certificate validation** (`buildTlsUpstreamCluster` in
  `src/envoyConfig.ts` sets no `validation_context`, so it accepts any upstream
  certificate on auth-terminated hosts — a separate, higher-severity issue
  recorded in the ambient-tls brief). The detector this spec builds is designed
  to be directly reusable there — it returns "the extra CA PEMs this machine
  needs," independent of "install into a guest" — but wiring it into
  `envoyConfig.ts` / `docker-compose.yml`'s `trusted_ca`, and the test that goes
  with it (point an auth-terminated host at a bad certificate, assert the proxy
  refuses), is follow-up work, not part of this change.
- **A manual override flag.** Earlier drafts of this design included
  `--extra-ca <path>`, repeatable, as an escape hatch for cases detection can't
  reach. It is deliberately dropped: detection is the sole mechanism.
- **Detecting interception on the guest's own path post-isolation.** Once a guest
  is isolated onto the Internal switch, it only ever reaches susentorno's own
  proxy stack, never the outer interceptor — so nothing here needs to run again,
  or persist ambient-CA trust, past the setup phase's pre-scripts.

## Design

### Architecture

`setup-guest-unix` gains one new, unconditional step — **ambient trust
propagation** — inserted immediately after the guest becomes reachable over SSH,
before `ensureKvpDaemon`, `mountShare`, or `runPreScripts` run. It has two halves:

1. A **host-side detector**, running elevated PowerShell, that enumerates
   Windows' trusted roots and filters out anything the host itself would not
   actually accept.
2. A **guest-side installer**, running over the existing `RemoteExec` seam, that
   diffs the detector's output against what the guest's base image already
   trusts, and installs only the difference.

On a machine with no ambient interception, the diff is empty and nothing is
installed — an exact no-op, which is the property the original brief wanted from
`--extra-ca` and gets here without an operator ever naming a file.

### Why detection, not a store diff against "the public root program"

The natural first idea — enumerate `Cert:\LocalMachine\Root`, subtract "the
public root program," keep the remainder — was rejected because Windows has no
local, authoritative list of public-root-program membership to diff against; any
local heuristic is an approximation.

The design instead diffs the host's candidates against **the guest's own
already-installed trust bundle** (`/etc/ssl/certs/` in the base image). This
needs no external reference list: on a clean machine, Windows' and Ubuntu's
public root sets overlap almost completely, so the difference is empty; on an
intercepted machine, the interceptor's CA is exactly the thing that doesn't match
anything already in the guest, so it's exactly what surfaces. This is also
immune to bundle staleness in either direction — it's a live comparison against
the guest's actual current state, not a snapshot of "what's in some store."

Fingerprints are computed over each certificate's **DER encoding** (SHA-256),
not its PEM text, on both sides of the diff. This matters for the no-op
guarantee specifically: Windows' PEM export and Ubuntu's own PEM formatting can
differ in line-wrapping and whitespace for byte-identical certificates, and a
text-based comparison would report those as "new," installing redundant copies
of already-trusted public roots on every run — a clean machine would no longer
be a true no-op.

### Why over-inclusion from the host side is an acceptable risk

The detector does not try to identify "the one CA that's the interceptor" — it
propagates the full filtered set of candidates that survive the diff. This is
deliberate, reached via the following reasoning:

- A trusted CA is only exploitable if something in the guest's actual traffic
  path can present a certificate signed by it. An unrelated root (a VPN client
  root, an internal PKI root, a stale entry from a since-abandoned network) isn't
  in that path, so propagating it is inert, not dangerous.
- The host's own direct use of the real GitHub/Anthropic/OpenAI credentials
  already depends on the same trust store, for the same hosts. If a stale or
  otherwise-questionable root in that store were exploitable, the host's own
  traffic is already exposed to it today — propagation to the guest inherits an
  existing risk rather than creating a new one.
- Two filters still apply before propagation, to exclude candidates the host
  itself would not actually accept (see below) — over-inclusion of *operative*
  host trust is fine; including something the host has explicitly been told not
  to trust, or that's scoped to a non-TLS purpose, is not the same thing and is
  excluded.

### Host-side filtering

Two exclusions apply when enumerating `Cert:\LocalMachine\Root` and
`Cert:\CurrentUser\Root` (for the user invoking the elevated `setup-guest-unix`
process — not all local users):

- **Disallowed.** Exclude any thumbprint also present in
  `Cert:\LocalMachine\Disallowed` or `Cert:\CurrentUser\Disallowed`. Microsoft can
  revoke trust in a root via the CTL disallow list without removing it from
  `Root`; reading `Root` alone can pick up something the host has already been
  told not to trust.
- **Enhanced Key Usage.** Exclude any cert whose `EnhancedKeyUsageList` (the
  *local* Windows store property `certmgr.msc` edits under "Intended Purposes" —
  distinct from the embedded X.509 EKU extension, which root certs rarely carry)
  is non-empty and does not include Server Authentication
  (`1.3.6.1.5.5.7.3.1`). An empty list means unrestricted, per Windows' own
  convention, and is kept.

The exact behavior of `EnhancedKeyUsageList` against a real store should be
confirmed with a small spike before the implementation plan commits to it, the
same way the Hyper-V guest tier plan spiked its own risky PowerShell assumptions
before writing builders against them.

### Components

- **`src/guestSetup/hostTrustStore.ts`** (new). Pure `buildXCommand()` /
  `parseX()` pair, following the `hyperVQueries.ts` JSON-over-`ConvertTo-Json`
  convention, plus a thin executor over `PowerShellExec`:

  ```typescript
  export interface HostTrustedRoot {
    thumbprint: string;
    pem: string;
  }
  export function buildEnumerateTrustedRootsCommand(): string;
  export function parseTrustedRootsResult(stdout: string): HostTrustedRoot[];
  export class HostTrustStoreError extends Error {}
  export async function enumerateHostTrustedRoots(
    exec: PowerShellExec,
  ): Promise<HostTrustedRoot[]>;
  ```

- **`src/guestSetup/ambientTrust.ts`** (new). Consumes `HostTrustedRoot[]` and a
  `RemoteExec`; queries the guest's existing trust fingerprints, diffs, installs
  survivors, runs `update-ca-certificates` only if the diff is non-empty:

  ```typescript
  export class AmbientTrustError extends Error {}
  export function buildListGuestFingerprintsCommand(): string;
  export function parseGuestFingerprints(stdout: string): string[];
  export function diffAmbientCandidates(
    hostRoots: HostTrustedRoot[],
    guestFingerprints: string[],
  ): HostTrustedRoot[];
  export function ambientCaFileName(thumbprint: string): string;
  export function buildInstallAmbientCaCommand(fileName: string, pem: string): string;
  export async function propagateAmbientTrust(
    exec: PowerShellExec,
    remoteExec: RemoteExec,
    onStep?: (message: string) => void,
  ): Promise<string[]>;
  ```

  `buildInstallAmbientCaCommand` reuses the base64-over-shell-quoting mechanism
  `tests/guest/extraCas.ts`'s `buildInstallExtraCaCommand` already proved out
  (a PEM crossing `bash -ic` as one shell-quoted argument cannot survive raw
  newlines, so it travels as base64). `ambientCaFileName` replaces
  `extraCaFileName`'s local-path basename source with the candidate's
  thumbprint, since there is no local file anymore.

- **`templates/vm-shared-linux/pre-scripts/nn-configure-network.sh`** (modified,
  one line). `NODE_EXTRA_CA_CERTS` currently points at susentorno's own single
  proxy-CA file, and this script runs last among pre-scripts, so it would
  otherwise clobber any ambient-CA entry set earlier. Point it at
  `/etc/ssl/certs/ca-certificates.crt` instead — the full system bundle
  `update-ca-certificates` maintains, containing susentorno's own CA and any
  propagated ambient CA(s) regardless of install order, since the bundle is
  rebuilt idempotently each time either script runs it.

- **`src/commands/setupGuestUnix.ts`** (modified). One new call,
  `propagateAmbientTrust(exec, remoteExec, onStep)`, inserted right after the SSH
  connection is established (`createSshRemoteExec`), before `ensureKvpDaemon`.
  `HostTrustStoreError` and `AmbientTrustError` join the existing `catch` block's
  list of errors that print a clean message and set `process.exitCode = 1`
  instead of escaping as a stack trace.

- **Removed**: `tests/guest/extraCas.ts`, `tests/unit/guest/extraCas.test.ts` (its
  assertions migrate to `tests/unit/guestSetup/ambientTrust.test.ts`), the
  `installExtraCas(target, 'e2e')` call and `EXTRA_CA_ENV_VAR`/
  `SUSENTORNO_TEST_EXTRA_CA` references in `tests/guest/e2e.test.ts`, and the
  "The manual export step should not survive" section of the ambient-tls brief
  (superseded — detection is what shipped, not documentation of a step to
  delete later).

### Data flow

1. Guest becomes reachable over SSH (existing behavior in `setupGuestUnix.ts`,
   unchanged).
2. Host side: `enumerateHostTrustedRoots(exec)` runs one PowerShell command,
   returns the filtered `HostTrustedRoot[]`.
3. Guest side: one SSH command fingerprints everything already in the guest's
   trust bundle.
4. `diffAmbientCandidates` compares by SHA-256 fingerprint. Empty result → log
   "no ambient interception detected," stop — no further guest round-trip.
5. Non-empty → base64-transfer each survivor's PEM to the guest, write to
   `/usr/local/share/ca-certificates/`, run `update-ca-certificates` once, log
   what was installed (filenames, count).
6. Provisioning continues unchanged: `ensureKvpDaemon` → `mountShare` →
   `runPreScripts` (now including the `nn-configure-network.sh` one-line change)
   → isolate → `mountShare` → `runPostScripts`.

### Error handling

- Host-side enumeration failing (non-zero PowerShell exit — e.g. cert-store
  access denied) throws `HostTrustStoreError`, caught by `setupGuestUnix.ts`'s
  existing error block the same way `MountShareError`/`RunPreScriptsError` are
  today.
- Guest-side fingerprinting or install failure throws `AmbientTrustError`, same
  treatment.
- No partial-install retry state: if some CAs are written but
  `update-ca-certificates` itself fails, that's a hard stop, matching
  `mountShare`'s existing all-or-nothing step pattern. Re-running
  `setup-guest-unix` from the top (already documented as safe/idempotent) covers
  recovery.

### Testing

- **Unit** (`tests/unit/guestSetup/hostTrustStore.test.ts`,
  `tests/unit/guestSetup/ambientTrust.test.ts`): command/parse builders,
  including the Disallowed-exclusion and EKU-filter logic baked into the
  enumeration command, and `diffAmbientCandidates`, all pure and
  Hyper-V-free — following `tests/unit/guest/vhd.test.ts`'s pattern for
  asserting exact PowerShell command strings.
- **Phase test** (real guest, deterministic regardless of the test machine's
  actual network — the guest tier's existing bar for anything that would
  otherwise only exercise real interception by accident): generate a throwaway
  CA via `generateRootCa()` (`src/ca.ts`, already used for susentorno's own
  proxy CA), import only `caCertPem` into `Cert:\CurrentUser\Root` — never
  `caKeyPem`, which is discarded immediately and never written to disk or passed
  to PowerShell, so a failed cleanup can leave at worst an inert trusted root,
  never a signing key — run `propagateAmbientTrust` (not the full
  `setup-guest-unix` flow) against a real test guest, assert the throwaway CA
  was written under `/usr/local/share/ca-certificates/` and that
  `update-ca-certificates` picked it up (e.g. `openssl verify` against the
  guest's system bundle accepts it), then remove the throwaway cert from
  `Cert:\CurrentUser\Root` in a `finally` block. This test does not touch
  `NODE_EXTRA_CA_CERTS` — `propagateAmbientTrust` runs before
  `nn-configure-network.sh` and doesn't set it; that reconciliation is covered
  by the existing-test update below.
- **`tests/guest/phases.test.ts:173`** ("configures NODE_EXTRA_CA_CERTS for
  login shells") currently asserts the env var contains
  `susentorno-proxy-certificate-authority.crt`, the old single-file target. It
  must be updated to assert it resolves to `/etc/ssl/certs/ca-certificates.crt`
  instead, matching the `nn-configure-network.sh` change — otherwise this test
  starts failing the moment that one line changes.
- **`tests/guest/e2e.test.ts`**: drops its manual staging entirely. The real
  `setup-guest-unix` path now covers this automatically — on a clean CI/dev
  machine it exercises the no-op branch; only a machine that's actually
  intercepted exercises real propagation through this path, same caveat the
  original brief accepted, now narrower since the phase test gives deterministic
  coverage independent of the test machine's own network.

## Scope note

This continues amending the Hyper-V guest test tier plan's Global Constraint "No
changes to `src/` beyond one line"
(`docs/honist-v/plans/2026-08-15-hyperv-guest-test-tier.md:13`), already amended
by the ambient-tls brief's own scope note for the same reason: that constraint
predates this problem.

## Follow-up work (explicitly deferred)

- **Envoy upstream certificate validation.** `buildTlsUpstreamCluster` sets no
  `validation_context` for any non-override upstream, so the proxy accepts any
  certificate on auth-terminated hosts — the ones carrying real GitHub/Claude/
  Codex credentials. `enumerateHostTrustedRoots`'s output is designed to be
  handed directly to a future `trusted_ca` bundle assembly, alongside the public
  root program, but that wiring, its interaction with
  `templates/proxy/docker-compose.yml`'s `./ca:/etc/envoy/ca:ro` mount, and its
  own test (auth-terminated host + bad certificate → proxy refuses rather than
  re-wraps) are a separate piece of work.
