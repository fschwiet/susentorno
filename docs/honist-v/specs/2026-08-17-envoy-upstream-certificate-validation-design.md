# Envoy upstream certificate validation

## Problem

`buildTlsUpstreamCluster` (`src/envoyConfig.ts:95`) sets `common_tls_context: {}`
for every non-override upstream — no `validation_context` at all. Envoy's
architecture documentation is explicit that this means no verification happens:

> Certificate verification for both upstream and downstream connections is
> disabled by default. It must be explicitly enabled by specifying one or more
> trusted authority certificates within the validation context.

That builder is used by all four TLS-terminating chains — `buildAuthCandidateEntry`,
`buildGithubEntry`, `buildClaudeEntry`, and `buildCodexEntry` — which is precisely
the set of destinations that carry credentials.

### Consequence

For a credential-injected destination the proxy stack accepts **any** certificate
the upstream presents: self-signed, expired, wrong hostname, attacker-controlled.
It then re-wraps the response in its own CA, which every guest is configured to
trust. So the guest sees a valid certificate and cannot detect the substitution —
the proxy's signature is exactly what it was told to expect — while the proxy
injects the **real** host credential into that unvalidated upstream connection.

Anyone able to intercept or redirect the proxy-to-origin connection for
`api.github.com` receives the real GitHub PAT, and similarly the Claude and Codex
tokens. Credential substitution is the reason these destinations are terminated at
all, so the unvalidated hop carries exactly what an attacker would want.

Passthrough destinations are unaffected: they are `tcp_proxy`, so the guest
performs its own end-to-end validation against the origin. Only the terminated set
is exposed. The MCP clusters (`buildMcpEntry`) are deliberately cleartext to
`host.docker.internal` and the HTTP/80 dynamic forward proxy has no TLS, so
neither goes through `buildTlsUpstreamCluster` and neither is in scope.

### Why this could not simply be switched on

Enabling validation naively would break the nested case that
`docs/honist-v/briefs/2026-08-16-ambient-tls-trust-propagation-brief.md` exists
for. Today Envoy accepts an outer interceptor's certificate precisely because it
validates nothing; turn validation on against the public root program alone and
the proxy can no longer reach any destination the outer environment terminates.

The two are one lever. Whatever bundle gets configured must contain the public
root program **and** any ambient interception CA the host is behind. The ambient
half already exists: `enumerateHostTrustedRoots` (`src/guestSetup/hostTrustStore.ts`),
built by the ambient TLS trust auto-detection work, returns exactly "the extra CA
material this machine trusts," filtered and deduplicated. That spec named this
change as the intended second consumer.

## Non-goals

- **Leaf revocation checking.** This change validates the certificate *chain* and
  the *name*. It does not check whether an origin's leaf certificate has been
  revoked — no CRL, no OCSP. Envoy supports a `crl` field on the validation
  context and there is no reasonable way to keep one current here. Recorded so
  that "the proxy validates upstream certificates" is not read as more than
  chain plus name.
- **Closing the root-program staleness gap.** See "Stated limitations" below.
  Node's bundled root set is a build-time snapshot and Windows' `Disallowed`
  store is lazily populated; where the two disagree and neither has caught up,
  the bundle trusts the root. There is no authoritative list either OS can query
  to fix this — the same conclusion the auto-detection spec reached when it
  rejected diffing against "the public root program."
- **Re-assembling the bundle while `run-hosting` is live.** Assembly happens once
  per `run-hosting` process. Policy reloads re-render `envoy.yaml` but never
  re-enumerate, because `trusted_ca` is a constant filename. Picking up a host
  trust change requires restarting `run-hosting`.
- **Validating MCP or HTTP/80 upstreams.** Neither uses TLS to the upstream; see
  above.

## Design

### Architecture

Three moving parts, one of them new.

A new pure module owns the question "what certificate authorities does the proxy
stack validate upstreams against?" and knows nothing about Envoy or about
`run-hosting`. `run-hosting` calls it once at startup and writes the result into
the already-mounted `ca/` directory. `envoyConfig.ts` points every TLS-terminated
cluster at that file and adds SAN matching.

Nothing else in the stack changes: `templates/proxy/docker-compose.yml:11` already
mounts `./ca:/etc/envoy/ca:ro`, and `templates/susentorno.gitignore`'s
ignore-everything-then-opt-in rule already ignores generated files under
`proxy/ca/`.

### Where the bundle comes from

The bundle is **Node's bundled public root program plus the host's ambient
trust**, deduplicated, with the host's distrust list applied to both sources.

`tls.rootCertificates` supplies the public root program: 118 roots, roughly
177 KB, available in-process with no external dependency. The host's ambient
trust comes from the existing `enumerateHostTrustedRoots`.

Three alternatives were rejected:

- **The Windows root store alone.** Measured on a real host, `Cert:\*\Root`
  yields 58 roots against Node's 118. Windows ships a subset and fetches the
  rest on demand through CTL auto-update; Envoy cannot trigger that fetch, so
  the proxy would fail to validate origins whose root the host has not cached
  yet — a machine-dependent, intermittent failure.
- **The Envoy container's own `/etc/ssl/certs/ca-certificates.crt`.** Zero
  assembly, but it contains no ambient CA, so it breaks exactly the nested case
  described above.
- **The container bundle plus ambient CAs.** Same trust set as the chosen
  option, but `trusted_ca` takes a single `DataSource`, so it needs either a
  container entrypoint that concatenates or a second mount and a build step.
  More moving parts for the same result.

### Chain verification *and* name verification

`trusted_ca` alone is a weaker fix than it appears. With chain-only validation
the proxy would reject a self-signed or attacker-minted certificate, but would
still accept a *validly issued* certificate for an unrelated domain and inject
the real credential into that connection. Anyone who controls any domain can
obtain such a certificate, so the threat the problem statement names — an
attacker who can intercept or redirect the proxy-to-origin connection — remains
open.

Both are therefore configured: `trusted_ca` plus `match_typed_subject_alt_names`
with an `exact` DNS matcher on the cluster's configured SNI host. Envoy's docs
state directly that SAN matching "must be used together with `trusted_ca`", and
its `exact` matcher follows DNS matching semantics including wildcard processing
(envoyproxy/envoy#10005), so an origin serving a `*.github.com` certificate
satisfies an `exact: api.github.com` matcher.

This does not reintroduce the nested-case breakage. Under ambient interception
the interceptor mints its leaf *for the requested hostname*, so it satisfies the
SAN match as well as chaining to a bundled ambient root.

### Applying the host's distrust list to both sources

`tls.rootCertificates` is the NSS root store compiled into the Node binary;
Mozilla's distrust decisions are applied when that bundle is generated, so a root
Mozilla pulled after the Node build stays present until Node is upgraded.
Meanwhile `hostTrustStore.ts` already reads `Cert:\*\Disallowed` and filters it
out of the host roots.

Applying that filter to one source and not the other would be incoherent: the
bundle could trust a root Windows has explicitly been told not to trust, purely
because it arrived through the Node door rather than the Windows door. So the
enumeration returns the Disallowed set alongside the surviving roots, and the
assembler applies it to **both** sources.

The Disallowed set must be keyed by SHA-256 over DER, not by Windows' SHA-1
thumbprint, so it can be compared against Node roots that never passed through a
Windows store. That means the enumeration command emits `RawDataBase64` for
Disallowed entries the same way it already does for roots.

Practical reach is limited and should not be overstated: on the development host
the Disallowed store is empty, and it is itself CTL-auto-updated and lazily
populated, so this filter will frequently be a no-op. It is the correct rule
rather than a large practical win — but a correct rule that is currently a no-op
is much better than an asymmetry that quietly becomes wrong later.

### `run-hosting` does not become an elevated command

Verified directly against a real host in a **non-elevated** session: the exact
production enumeration command from `buildEnumerateTrustedRootsCommand` — both
`Disallowed` stores, both `Root` stores, the EKU filter — runs successfully and
returns 58 roots. `X509Store.Open('ReadOnly')` on `LocalMachine\Root` does not
require an elevated token; only writing to that store does, which is why
`tests/guest/hyperv/localMachineRoot.ts` needs elevation and this does not.

`run-hosting` has no `checkElevated()` today — only the host-network and guest
tiers do, and the proxy-stack tier runs `run-hosting` unelevated. This change
adds no new requirement. Stated explicitly because "we are adding a PowerShell
call to `run-hosting`" is exactly the kind of change a reader would assume drags
elevation along with it.

### Stated limitations

- **Node bundle staleness.** The public root set is only as fresh as the Node
  build. The startup log line reports the Node version alongside the counts so
  that age is visible to an operator rather than inferred.
- **Divergent distrust.** Where Mozilla has distrusted a root and Windows has
  not (or vice versa) and neither local list has caught up, the bundle trusts it.
  Not locally closable; see Non-goals.
- **Expired roots are not filtered.** A chain cannot build through an expired
  root, so including one is inert rather than dangerous. A filter would be code
  that never changes an outcome.

## Components

- **`src/runHosting/upstreamTrustBundle.ts`** (new). The deep module: given
  certificate material, produce the bundle. No knowledge of Envoy, PowerShell,
  or `run-hosting`.

  ```typescript
  export interface TrustBundleSources {
    /** PEMs from readPublicRootProgram(). */
    publicRoots: string[];
    /** From enumerateHostTrustedRoots(). */
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
    /** Individually unparseable PEMs, dropped rather than fatal. */
    skippedCount: number;
    totalCount: number;
  }
  export function readPublicRootProgram(): string[];
  export function assembleUpstreamTrustBundle(sources: TrustBundleSources): UpstreamTrustBundle;
  export function writeUpstreamTrustBundle(path: string, bundle: UpstreamTrustBundle): void;
  export class UpstreamTrustBundleError extends Error {}
  ```

  `readPublicRootProgram()` is a one-line wrapper over `tls.rootCertificates`,
  kept separate so `assembleUpstreamTrustBundle` stays pure over injected inputs
  and unit tests can supply fixtures.

  Deduplication and the Disallowed comparison both use SHA-256 over DER —
  `createHash('sha256').update(new X509Certificate(pem).raw)` — the same key
  `hostTrustStore.ts` already computes, so a host root that *is* a public root
  contributes once and `ambientRootCount` means what it says.

  Order: public roots, then host roots not already present, then `extraCaPem`.
  An individual PEM that will not parse is skipped and counted, mirroring
  `parseTrustedRootsResult`'s existing rule that malformed entries do not fail
  the batch. An empty final bundle throws `UpstreamTrustBundleError`, since that
  can only mean something is badly wrong.

- **`src/guestSetup/hostTrustStore.ts`** (modified). The enumeration command
  additionally emits `RawDataBase64` for `Disallowed` entries, and the module
  returns the distrust set instead of discarding it after filtering:

  ```typescript
  export interface HostTrustSnapshot {
    roots: HostTrustedRoot[];
    disallowedSha256: string[];
  }
  export async function enumerateHostTrustedRoots(
    exec: PowerShellExec,
  ): Promise<HostTrustSnapshot>;
  ```

  The existing internal filtering is unchanged; only the return type widens and
  the previously-discarded set is carried out. `src/commands/setupGuestUnix.ts`
  and `src/guestSetup/ambientTrust.ts` are updated for the new return shape and
  ignore `disallowedSha256` — their behaviour does not change.

- **`src/envPaths.ts`** (modified). One new entry,
  `upstreamTrustBundle: join(proxy, 'ca', 'upstream-trust.pem')`, mounting into
  the container at `/etc/envoy/ca/upstream-trust.pem`.

- **`src/envoyConfig.ts`** (modified). `buildTlsUpstreamCluster` gains a
  `verifyOverrides: boolean` parameter and its `common_tls_context` becomes:

  ```typescript
  common_tls_context: override && !verifyOverrides
    ? { validation_context: { trust_chain_verification: 'ACCEPT_UNTRUSTED' } }
    : {
        validation_context: {
          trusted_ca: { filename: '/etc/envoy/ca/upstream-trust.pem' },
          match_typed_subject_alt_names: [{ san_type: 'DNS', matcher: { exact: sniHost } }],
        },
      },
  ```

  `trust_chain_verification` is omitted on the validating branch because
  `VERIFY_TRUST_CHAIN` is already its default. `BuildEnvoyConfigOptions` gains
  `verifyUpstreamOverrides?: boolean`, threaded through `writeEnvoyConfig` the
  same way `skipAllowList` is today. All four call sites pass it through;
  `buildMcpEntry` and the HTTP/80 clusters are untouched.

- **`src/runHosting/buildConfig.ts`** (modified). `writeEnvoyConfig` takes the
  new option and forwards it, matching its existing parameter style.

- **`src/commands/runHosting.ts`** (modified). One new startup block plus one new
  flag, `--verify-upstream-overrides <caPath>`, marked "(test use only)"
  alongside `--upstream-override` and `--inject-fault`. That single flag does
  both jobs: it sets `verifyUpstreamOverrides` and supplies `extraCaPem`, so a
  test that opts an override cluster into real validation necessarily also says
  what that cluster should trust.

## Data flow

At `run-hosting` startup, in order:

1. Existing `paths.caCert` / `paths.caKey` existence check (unchanged).
2. `enumerateHostTrustedRoots(createRealPowerShellExec())` — one PowerShell
   invocation, returning the filtered, deduplicated roots and the distrust set.
3. `assembleUpstreamTrustBundle({ publicRoots: readPublicRootProgram(), hostRoots,
   disallowedSha256, extraCaPem })` — pure, no I/O.
4. `writeUpstreamTrustBundle(paths.upstreamTrustBundle, bundle)` — into the
   existing `ca/` directory, which is guaranteed to exist because step 1 just
   found files in it.
5. One log line, e.g.
   `run-hosting: upstream trust bundle: 118 public roots (node v26.7.0) + 3 ambient = 121 (0 disallowed, 2 skipped)`.
6. Gateway, DNS/DHCP, and the supervisor deps are constructed as they are today.

`deps.buildConfig` renders `envoy.yaml` with a constant `trusted_ca` filename, so
policy reloads never re-enumerate: steps 2–4 happen exactly once per process.
Blue/green swaps need no special handling — the bundle is written before any
container starts, and each color mounts the same read-only path.

## Error handling

- `HostTrustStoreError` from step 2 and `UpstreamTrustBundleError` from steps 3–4
  each print `run-hosting: <message>` and return with `process.exitCode = 1`,
  before the gateway binds anything — the same fail-before-you-start shape as the
  missing-CA and unreadable-`mcp-servers.yaml` checks immediately above them.
- **No fallback to public-roots-only.** The fallback would be strictly safer in
  trust terms, so there is no security argument for stopping the line. It is
  rejected because it produces the failure shape both TLS briefs were written to
  eliminate: a silently narrowed trust set manifesting later as every terminated
  destination returning 503 inside the guest, with nothing connecting that to a
  certificate-store read that failed at startup. A warning in a long-running
  supervisor's output is easy to scroll past; a refusal to start is not. Reading
  two local certificate stores read-only touches no network and needs no
  elevation, so a failure here means something is genuinely wrong with the
  machine.
- A write failure in step 4 is wrapped in `UpstreamTrustBundleError` rather than
  escaping as a raw `EACCES`/`ENOENT`, meeting the same "clean message, not a
  stack trace" bar the guest-side error classes already meet.
- `--verify-upstream-overrides <caPath>` pointing at a missing or unparseable
  file is the same class: clean message, exit 1, before startup. A silent no-op
  there would make a test pass for the wrong reason.
- Runtime validation failures need no new handling. Envoy returns 503 and the
  existing `CFGM|` access-log line carries `%RESPONSE_CODE_DETAILS%` with the TLS
  error and `%RESPONSE_FLAGS%`.
- `alertOnNonzeroExit` stays true on these paths, so an abnormal-exit alert fires
  as it would for any other startup refusal.

## Testing

### Unit — `tests/unit/runHosting/upstreamTrustBundle.test.ts` (new)

The assembler is pure, so each rule gets its own case rather than being folded
into a happy path:

- a host root whose SHA-256 matches a public root → present once, and **not**
  counted in `ambientRootCount`;
- a host root absent from the public set → `ambientRootCount` 1, its PEM present
  in the output;
- a public root whose SHA-256 is in `disallowedSha256` → excluded. This is the
  case that would silently regress if someone later "simplified" the filter back
  to host-roots-only;
- a host root in `disallowedSha256` → also excluded, asserted here rather than
  relying on `hostTrustStore.ts` having already done it, so the assembler is
  correct standalone;
- an unparseable PEM → skipped, `skippedCount` incremented, remaining certs
  unaffected;
- an empty final bundle → throws `UpstreamTrustBundleError`;
- `extraCaPem` appended;
- the output parses as concatenated PEM (every block delimited,
  newline-terminated) — cheap insurance against the "bundle rejects everything"
  failure the integration positive case also guards.

### Unit — `tests/unit/guestSetup/hostTrustStore.test.ts` (extended)

The enumeration command emits `RawDataBase64` for Disallowed entries, and the
parser returns `disallowedSha256` keyed by DER SHA-256 rather than Windows'
SHA-1 thumbprint. Existing assertions about root filtering are unchanged.

### Unit — `tests/unit/proxyConfig.test.ts` (extended)

Rendered-YAML assertions:

- all four TLS-terminated clusters carry `trusted_ca` at
  `/etc/envoy/ca/upstream-trust.pem` and a DNS SAN matcher whose `exact` value is
  the cluster's SNI host;
- with no overrides configured, `ACCEPT_UNTRUSTED` appears nowhere;
- an override without `verifyUpstreamOverrides` still renders `ACCEPT_UNTRUSTED`;
- an override **with** `verifyUpstreamOverrides` renders the production
  validation context and matches on the SNI host, not the override target;
- the MCP cluster and the HTTP/80 clusters are unchanged.

### Proxy-stack — `tests/proxy-stack/upstreamValidation.test.ts` (new)

`githubInjection.test.ts` writes its own `auth-list.txt` inline rather than using
the shared fixture, so this suite does the same and no other suite is disturbed.
Three destinations in the claude section — all credential-injected, which is what
makes the leak assertion meaningful — against three mock upstreams, under **one**
`run-hosting` process started with `--verify-upstream-overrides <throwawayCaPath>`
and an `--upstream-override` per destination:

| destination | server certificate | expected |
|---|---|---|
| `claude-good.test` | leaf from the throwaway CA, SAN matches | 200, mock received the real credential |
| `claude-badname.test` | leaf from the throwaway CA, SAN `somewhere-else.test` | 503, mock received **nothing** |
| `claude-untrusted.test` | self-signed, SAN matches | 503, mock received **nothing** |

The throwaway CA and its leaves come from `src/ca.ts`'s existing
`generateRootCa()` and `generateLeaf`, so no Windows trust store is involved and
the tier stays unelevated.

The "mock received nothing" assertion is what actually encodes the problem
statement's concern: it proves the handshake failed *before* the credential
crossed, not merely that the client saw an error. The middle row is what proves
SAN matching is live rather than chain-building alone — without it, a
chain-only configuration would pass the suite.

One case also asserts a `CFGM|` line with a 503 for its destination, tying the
diagnostics documentation to observed behaviour, without pinning Envoy's exact
TLS error string, which is version-dependent.

`tests/proxy-stack/mockUpstream.ts` gains an optional "serve this key and
certificate" mode. Its current hardcoded certificate has CN `mock-upstream` and
**no SANs at all**, so it would fail SAN matching even if it were trusted; that
change is required regardless of which row it serves.

### Unchanged tiers

`tests/proxy-stack/globalSetup.ts` gains nothing: no elevation, no new external
dependency. `githubInjection`, `codexInjection`, `stackLifecycle`, and
`tests/proxyStack.ts` are untouched, because `--upstream-override` keeps its
`ACCEPT_UNTRUSTED` behaviour unless the new flag opts in.

## Documentation and records

- **`docs/adr/0026-validate-upstream-certificates-against-ambient-trust.md`**
  (new). Records the decision as a statement: the proxy stack validates every
  TLS-terminated upstream against a bundle of the public root program plus the
  host's ambient trust, with SAN matching on the configured SNI host. The
  rejected options carry the weight — the container's own bundle (breaks the
  nested case), the Windows store alone (58 roots measured against Node's 118, so
  incomplete on a fresh machine), and chain verification without SAN matching
  (leaves the credential-theft path open). Links to
  `[[root-ca-plus-derived-leaf]]` (the downstream half of the same TLS story),
  `[[credential-injection-at-proxy]]` (what is at stake on the unvalidated hop),
  and `[[transparent-interception-and-network-isolation-boundary]]`.

- **`CONTEXT.md`** (modified). New term under Network policy:

  > **Upstream trust bundle**: The assembled set of certificate authorities the
  > proxy stack validates terminated upstream connections against, combining the
  > public root program with the host's ambient trust. _Avoid_: CA bundle,
  > trusted_ca, root bundle

  Worth naming because "the CA" is already overloaded here — the proxy root CA,
  its derived leaf, the ambient CAs propagated into guests, and now this — and
  all of them live under `.susentorno/proxy/ca/`.

- **`diagnostics.md`** (modified). A short section under "Watching proxy traffic"
  on reading a validation failure out of the `CFGM|` line, naming the two likely
  causes: an origin whose SANs do not cover the SNI name, or an ambient
  interceptor whose CA did not reach the bundle.

- **`testing.md`** — no change. The proxy-stack prerequisites row stays accurate
  because nothing here adds elevation or a new external dependency.

- **`docs/honist-v/briefs/2026-08-16-ambient-tls-trust-propagation-brief.md`**
  (modified). The "Split this out: Envoy does not validate upstream
  certificates" section is removed, superseded by this spec — the same treatment
  the auto-detection spec gave that brief's "The manual export step should not
  survive" section once detection shipped.

- **`docs/honist-v/specs/2026-08-16-ambient-tls-trust-auto-detection-design.md`**
  (modified). Its "Follow-up work (explicitly deferred)" entry gains a pointer to
  this spec rather than being left as an open deferral.

## Scope note

This continues amending the Hyper-V guest test tier plan's Global Constraint "No
changes to `src/` beyond one line"
(`docs/honist-v/plans/2026-08-15-hyperv-guest-test-tier.md:13`), already amended
twice for the same reason: that constraint predates both TLS problems.
