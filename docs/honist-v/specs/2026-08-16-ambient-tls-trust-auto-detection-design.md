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
- **Re-running detection after isolation, or reconciling against host-side
  drift.** Detection runs once, during setup. The trust it installs is *not*
  removed or re-checked after isolation — see "Why over-inclusion... and why
  this trust persists" below for why that's required for correctness, not an
  oversight. What's genuinely out of scope is actively noticing that the host's
  situation changed after provisioning (interceptor rotated, machine moved
  networks); that's picked up only by re-running `setup-guest-unix`.

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

On a machine with no ambient interception, the diff is typically empty and
nothing is installed. This is not a literal, guaranteed no-op — see the
following section — but it's the property the original brief wanted from
`--extra-ca`, and it gets here without an operator ever naming a file.

### Why detection, not a store diff against "the public root program"

The natural first idea — enumerate `Cert:\LocalMachine\Root`, subtract "the
public root program," keep the remainder — was rejected because Windows has no
local, authoritative list of public-root-program membership to diff against; any
local heuristic is an approximation.

The design instead diffs the host's candidates against **the guest's own
already-installed trust bundle** (`/etc/ssl/certs/` in the base image). This
needs no external reference list, and it's immune to bundle *staleness* in
either direction — it's a live comparison against the guest's actual current
state, not a snapshot of "what's in some store."

It is not, however, an exact "clean machine → empty diff" guarantee. Windows'
and Ubuntu's public root sets overlap heavily but not completely — different
root programs, different release cadences, vendor roots one ships and the other
doesn't — so a genuinely clean machine can still see a handful of legitimate,
Windows-only public roots classified as "extra" and installed. A rarer, sharper
version of the same gap: a root Ubuntu deliberately dropped (a known compromise)
could be reintroduced from the Windows side if Windows hasn't purged it yet —
the Disallowed-store check below catches this only if Windows' own disallow list
has already caught up. Both are accepted, documented limitations of diffing
against local state rather than an authoritative external reference, which
doesn't exist in a form either OS can query. A future live-handshake-probe
mechanism (test real hosts, capture only what's actually presented) would close
this gap more precisely, at the cost of the complexity this design deliberately
avoided; it isn't part of this change.

Fingerprints are computed over each certificate's **DER encoding** (SHA-256),
not its PEM text, on both sides of the diff. This is a separate concern from
the gap noted above: Windows' PEM export and Ubuntu's own PEM formatting can
differ in line-wrapping and whitespace for byte-identical certificates, and a
text-based comparison would report those as "new" purely from formatting
differences — adding spurious reinstalls of already-trusted public roots on
every run, on top of the legitimate Windows-only-root gap that's unavoidable
regardless of encoding.

### Why over-inclusion from the host side is an acceptable risk, and why this trust persists

The detector does not try to identify "the one CA that's the interceptor" — it
propagates the full filtered set of candidates that survive the diff, and the
guest keeps trusting them indefinitely, not just during the setup phase. Both
choices are deliberate:

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
- Trusting a wider CA set doesn't widen *which* destinations the guest can
  reach post-isolation — that's governed entirely by the proxy stack's allow/
  auth/block lists, which are orthogonal to TLS trust. Ambient CA trust only
  affects whether certificate validation *succeeds* for destinations the policy
  already permits; it grants no new reachability.

Persistence past isolation is not just tolerated, it's required for
correctness. Once isolated, every guest connection — including "passthrough"
(allow-listed) hosts — routes through Envoy, and Envoy runs on this same
Windows host. A passthrough host is `tcp_proxy`: Envoy relays the raw TCP
connection without terminating TLS, so the guest's own TLS session is meant to
be end-to-end with the real origin. But that relay's underlying TCP connection
still originates from this host, and if the host sits behind an ambient
interceptor, the interceptor decides what to terminate based on the
destination, not on who's asking or how susentorno classified it. A passthrough
host the interceptor happens to terminate would present the interceptor's
certificate to Envoy's outbound leg, relayed straight through to the guest —
and the guest's own end-to-end validation would fail unless it still trusts
that CA. So this trust reflects a standing fact about where this host's network
egress actually terminates, for as long as the guest's traffic keeps relaying
through it — not an artifact of one provisioning run that stops mattering once
isolation happens.

This has one consequence worth stating plainly: nothing here actively
reconciles against the host's situation changing later (interceptor rotated,
CA replaced, machine moved to a different network). A guest's ambient trust
reflects the host at provisioning time; picking up a later change requires
re-running `setup-guest-unix`, the same way any other state it installs
doesn't self-update without a rerun. No new reconciliation machinery is added
to handle this.

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
  (`1.3.6.1.5.5.7.3.1`) **and** does not include `anyExtendedKeyUsage`
  (`2.5.29.37.0`), which denotes unrestricted purpose and must not be treated as
  a restriction. An empty list also means unrestricted, per Windows' own
  convention, and is kept.

After filtering, results from `LocalMachine\Root` and `CurrentUser\Root` are
**deduplicated by DER SHA-256 fingerprint** before anything downstream sees
them — the same certificate commonly appears in both stores, and installing it
twice would double-count logs, double the SSH round-trips, and leave it
ambiguous which store's EKU/Disallowed evaluation "won" for a cert that
appeared in both. A disallow in either scope excludes it.

None of this is safe to take on faith. Before the implementation plan commits
to it, a spike should confirm, against a real Windows install:

- The actual runtime behavior of `EnhancedKeyUsageList` — in particular
  whether it reliably distinguishes the *local* "Intended Purposes" property
  from the embedded X.509 EKU extension, since PowerShell can expose both and
  conflating them would misclassify certs.
- Whether enumerating certificate objects under `Cert:\*\Disallowed` actually
  reflects Windows' *effective* CTL-based disallow decision, or whether a
  disallowed root can fail to appear there as a certificate object even though
  Windows' own chain validation would reject it — in which case a chain-build
  check (e.g. .NET `X509Chain`) would be the more authoritative source than
  store enumeration.

This is the same category of validation the Hyper-V guest tier plan already
did for its own risky PowerShell assumptions (Task 4's boot spike) before
writing builders against them.

### Components

- **`src/guestSetup/remoteExec.ts`** (modified). `RemoteExec.run()` uses
  `stdio: 'inherit'` and returns only `exitCode` — there is currently no way to
  get a command's stdout back into the process, which the guest-side
  fingerprint query needs. Add a second method:

  ```typescript
  export interface RemoteExecCaptureResult extends RemoteExecResult {
    stdout: string;
  }
  export interface RemoteExec {
    run(remoteCommand: string): Promise<RemoteExecResult>;
    capture(remoteCommand: string): Promise<RemoteExecCaptureResult>;
    copyFile(localPath: string, remoteDestPath: string): Promise<RemoteExecResult>;
  }
  ```

  `run()` keeps `stdio: 'inherit'` for steps where the user should see live
  output (sudo prompts, package-manager progress). `capture()` is for read-only
  queries with no interactive output expected, and pipes stdout back instead of
  inheriting it — the same shape `tests/guest/guestExec.ts`'s `guestCapture`
  already uses in the test harness, promoted to the production seam.

- **`src/guestSetup/hostTrustStore.ts`** (new). Pure `buildXCommand()` /
  `parseX()` pair, following the `hyperVQueries.ts` JSON-over-`ConvertTo-Json`
  convention, plus a thin executor over `PowerShellExec`:

  ```typescript
  export interface HostTrustedRoot {
    /** Windows' own thumbprint (SHA-1 by convention) — carried through for
     * logging/diagnostics, not used as the comparison key. */
    thumbprint: string;
    /** SHA-256 over the certificate's DER encoding — the actual diff/dedup key. */
    sha256: string;
    pem: string;
  }
  export function buildEnumerateTrustedRootsCommand(): string;
  export function parseTrustedRootsResult(stdout: string): HostTrustedRoot[];
  export function dedupeBySha256(roots: HostTrustedRoot[]): HostTrustedRoot[];
  export class HostTrustStoreError extends Error {}
  export async function enumerateHostTrustedRoots(
    exec: PowerShellExec,
  ): Promise<HostTrustedRoot[]>;
  ```

  `enumerateHostTrustedRoots` runs one command covering both
  `LocalMachine\Root` and `CurrentUser\Root`, applies the Disallowed/EKU
  filters and `dedupeBySha256`, and returns the survivors.

- **`src/guestSetup/ambientTrust.ts`** (new). Consumes `HostTrustedRoot[]` and a
  `RemoteExec`; queries the guest's existing trust fingerprints, diffs, installs
  survivors, runs `update-ca-certificates` only if the diff is non-empty, and
  makes `NODE_EXTRA_CA_CERTS` available before any pre-script runs:

  ```typescript
  export class AmbientTrustError extends Error {}
  export function buildListGuestFingerprintsCommand(): string;
  export function parseGuestFingerprints(stdout: string): string[];
  export function diffAmbientCandidates(
    hostRoots: HostTrustedRoot[],
    guestFingerprints: string[],
  ): HostTrustedRoot[];
  export function ambientCaFileName(sha256: string): string;
  export function buildInstallAmbientCaCommand(fileName: string, pem: string): string;
  export function buildSetNodeExtraCaCertsCommand(): string;
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
  `extraCaFileName`'s local-path basename source with the candidate's SHA-256
  fingerprint, since there is no local file anymore.

  `buildSetNodeExtraCaCertsCommand` writes
  `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` into
  `/etc/environment` — a PAM-level file read for any SSH session regardless of
  shell type, unlike `/etc/profile.d` (login-shell only, and not sourced by the
  `bash -ic` invocation `RemoteExec` uses). This closes a real ordering gap:
  `03-install-tools.sh` runs Node-based installs (`pnpm add -g`, `pnpm runtime
  set node latest -g`) *before* `nn-configure-network.sh` (which runs last
  among pre-scripts) would otherwise set this variable, so without this,
  Node-based tooling in earlier pre-scripts has no way to trust an ambient CA
  even after it's in the system store. Running `propagateAmbientTrust` first —
  ahead of every pre-script — means this is in place from the start. The
  PAM/`/etc/environment` behavior should be confirmed in the same spike as the
  Windows-side assumptions; if it doesn't hold as expected, the fallback is
  having `runPreScripts` pass the variable explicitly into each script's
  invocation.

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
2. Guest side: `buildSetNodeExtraCaCertsCommand()` writes
   `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` into
   `/etc/environment`, unconditionally — this doesn't depend on anything
   ambient being detected, it just needs to be in place before any pre-script
   (Node-based or not) runs.
3. Host side: `enumerateHostTrustedRoots(exec)` runs one PowerShell command,
   returns the filtered, deduplicated `HostTrustedRoot[]`.
4. Guest side: one SSH `capture()` command fingerprints (DER SHA-256) everything
   already in the guest's trust bundle.
5. `diffAmbientCandidates` compares by SHA-256. Empty result → log "no ambient
   interception detected," stop — no install round-trip needed.
6. Non-empty → base64-transfer each survivor's PEM to the guest, write to
   `/usr/local/share/ca-certificates/`, run `update-ca-certificates` once, log
   what was installed (filenames, count). Nothing here is later removed —
   see "Why over-inclusion... and why this trust persists" above.
7. Provisioning continues unchanged: `ensureKvpDaemon` → `mountShare` →
   `runPreScripts` (now including the `nn-configure-network.sh` one-line change)
   → isolate → `mountShare` → `runPostScripts`. Because step 2 already set
   `NODE_EXTRA_CA_CERTS`, and step 6's ambient CAs are already in the system
   store, Node-based tooling anywhere in `runPreScripts` — including
   `03-install-tools.sh`, which runs before `nn-configure-network.sh` — can
   already validate through an ambient interceptor by the time it runs.

### Error handling

- Host-side enumeration failing (non-zero PowerShell exit — e.g. cert-store
  access denied) throws `HostTrustStoreError`, caught by `setupGuestUnix.ts`'s
  existing error block the same way `MountShareError`/`RunPreScriptsError` are
  today.
- The enumeration command must set an error-terminating preference (e.g.
  `$ErrorActionPreference = 'Stop'`) so a PowerShell cmdlet error surfaces as a
  failure rather than a non-terminating warning alongside a zero exit code —
  `Get-ChildItem` against a store it can't fully read is exactly this shape,
  and a non-terminating error there must not be allowed to produce a "clean
  scan" result silently.
- `createRealPowerShellExec()` runs with `all: true`, which merges stdout and
  stderr into one stream — the enumeration command's `ConvertTo-Json` output
  must not have anything else mixed into that stream, or a stray warning line
  breaks the JSON. `parseTrustedRootsResult`/`parseGuestFingerprints` wrap
  `JSON.parse` failures in `HostTrustStoreError`/`AmbientTrustError` rather than
  letting a raw `SyntaxError` escape — this is the same "clean message, not a
  stack trace" bar the existing error classes already meet for a non-zero exit.
- Guest-side fingerprinting (`capture()`) or install (`run()`) failure throws
  `AmbientTrustError`, same treatment.
- No partial-install retry state: if some CAs are written but
  `update-ca-certificates` itself fails, that's a hard stop, matching
  `mountShare`'s existing all-or-nothing step pattern. Re-running
  `setup-guest-unix` from the top (already documented as safe/idempotent) covers
  recovery.

### Testing

- **Unit** (`tests/unit/guestSetup/hostTrustStore.test.ts`,
  `tests/unit/guestSetup/ambientTrust.test.ts`): command/parse builders, all
  pure and Hyper-V-free, following `tests/unit/guest/vhd.test.ts`'s pattern for
  asserting exact PowerShell command strings. Explicitly covers, as separate
  cases rather than folded into the "happy path" assertions:
  - a Disallowed-listed thumbprint excluded even though it's present in `Root`;
  - an EKU-restricted (non-server-auth) cert excluded, and one restricted to
    `anyExtendedKeyUsage` kept;
  - the same certificate present in both `LocalMachine\Root` and
    `CurrentUser\Root` producing exactly one entry after `dedupeBySha256`;
  - `diffAmbientCandidates` given a host candidate whose SHA-256 already
    appears in the guest's fingerprint list, producing no result for it.
- **Phase test** (real guest, deterministic regardless of the test machine's
  actual network — the guest tier's existing bar for anything that would
  otherwise only exercise real interception by accident): generate a throwaway
  CA via `generateRootCa()` (`src/ca.ts`, already used for susentorno's own
  proxy CA), import only `caCertPem` into `Cert:\CurrentUser\Root` — never
  `caKeyPem`, which is discarded immediately and never written to disk or passed
  to PowerShell, so a failed cleanup can leave at worst an inert trusted root,
  never a signing key — run `propagateAmbientTrust` (not the full
  `setup-guest-unix` flow) against a real test guest, and assert:
  - the throwaway CA was written under `/usr/local/share/ca-certificates/` and
    `update-ca-certificates` picked it up;
  - a server-auth **leaf** signed by the throwaway root (via `src/ca.ts`'s
    existing `generateLeaf`, minted before the root key is discarded) verifies
    against the guest's system bundle with `openssl verify -purpose sslserver`
    — proving TLS server-auth chain behavior, not just "the root is present";
  - running `propagateAmbientTrust` a second time against the same guest is
    idempotent — no duplicate file, no duplicate `update-ca-certificates`
    side effect, same result, and — this is the concrete check for "this trust
    persists" from the design section above — nothing in `propagateAmbientTrust`
    or elsewhere in `setup-guest-unix` ever removes what this step installed,
    so the throwaway CA it wrote on the first run is still present and still
    verifying on the second.

  Then remove the throwaway cert from `Cert:\CurrentUser\Root` in a `finally`
  block, regardless of outcome. This test does not touch `NODE_EXTRA_CA_CERTS`
  — that's `buildSetNodeExtraCaCertsCommand`'s job, exercised by its own unit
  test and by the existing-test update below.
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

- **Envoy upstream certificate validation.** No longer deferred — designed in
  `docs/honist-v/specs/2026-08-17-envoy-upstream-certificate-validation-design.md`,
  which consumes `enumerateHostTrustedRoots`'s output as this spec anticipated.
