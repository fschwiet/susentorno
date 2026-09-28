# Define Windows ambient-trust propagation

Type: grilling
Status: resolved
Blocked by: 02

## Question

How should the production Windows setup path propagate host ambient trust before any pre-isolation provisioning step accesses the network?

Decide how to promote or adapt the existing guest-tier Windows root-store logic; when host roots are enumerated and guest roots fingerprinted; which store receives missing roots; how reruns and partial imports behave; and how failures are reported. Resolve the interaction between ambient roots, the susentorno proxy CA installed by `configure-network`, and Node's `NODE_EXTRA_CA_CERTS`: the final design must not make Node trust only one set while Windows and Git trust another.

The answer must remain consistent with ADR-0028's trust-selection policy and ADR-0027's observation that the Windows implementation was deferred only until a production caller existed.

## Answer

Use one host-driven **Windows guest trust reconciliation** before any pre-isolation provisioning step. It owns every trust mutation needed by setup: propagating host ambient trust, installing the environment's proxy CA, and publishing Node's supplemental bundle. The shipped `configure-network` step must not independently install certificates or overwrite `NODE_EXTRA_CA_CERTS`.

### Inputs and timing

After host and guest preflight, PowerShell Direct readiness, and elevation checks, take one immutable trust snapshot for the complete replay:

1. enumerate the host's Local Machine and Current User roots through the existing production `enumerateHostTrustedRoots`, preserving its Disallowed-store and server-authentication EKU policy;
2. read and validate the environment's `cert.pem` on the host; and
3. fingerprint the guest's `LocalMachine\\Root` certificates by SHA-256 over DER through the credential-scoped `WindowsGuestExecutor`.

Do this after reconciliation to the Default Switch and before the first pre-isolation step can access the network. Do not refresh the host snapshot midway through a run; host trust changes take effect on the next complete replay. Reuse the production host enumerator and shared SHA-256 diff model, but graduate the guest-side Windows logic from `tests/guest/windowsAmbientTrust.ts` into a production Windows-specific reconciler rather than adding Windows branches to the Unix installer.

No corresponding Unix restructuring is required. Unix already has one effective bundle: ambient roots and the proxy CA enter the system store through `update-ca-certificates`, and Node points at that full system bundle. Windows has no equivalent PEM artifact, so it needs explicit ownership of one.

### Reconciled state

Install selected certificates into `LocalMachine\\Root` only. This is the machine-wide store used by Schannel, .NET, and Git after Git is configured for `schannel`. Never write Current User trust. Diff and deduplicate by lowercase SHA-256 over DER, not Windows' SHA-1 thumbprint or PEM text.

Maintain trust artifacts under `C:\\ProgramData\\susentorno\\trust`:

- one fingerprint-named PEM for each host root selected by the snapshot, retaining PEMs propagated by earlier runs;
- the current environment proxy CA PEM;
- a manifest identifying the managed ambient fingerprints and the current managed proxy fingerprint; and
- one combined Node supplemental PEM bundle containing every retained managed ambient root plus the current proxy CA, with duplicate certificates emitted once.

Set machine-scoped `NODE_EXTRA_CA_CERTS` to the stable combined bundle. Node retains its built-in public roots and gains both classes of additional trust; it must never be pointed at the proxy CA alone. Consequently Windows, Git, and Node all receive the ambient roots and current proxy CA managed by setup.

Ambient trust is additive, matching ADR-0028: replay never removes an ambient root or its managed PEM merely because a later host snapshot no longer selects it. For each currently selected host root, retain its PEM even when the guest already has the certificate, so Node receives host-selected trust that was not originally imported by susentorno.

The environment proxy CA is replaceable rather than additive. When `cert.pem` changes, first install and verify the new proxy CA, publish the new bundle, and then remove the old proxy certificate only when the managed state proves that exact fingerprint was installed as the prior environment proxy. Never infer ownership from subject or issuer text. If ownership is ambiguous, fail without deleting trust. A proxy certificate that is also selected as an ambient root is deduplicated in files, imports, and the bundle, and must not be removed while its retained ambient role remains.

### Replay and partial failure

Validate all certificate inputs and managed state before mutating trust. Stage replacement files in the managed directory, then:

1. write or repair fingerprint-named ambient PEMs;
2. import each missing ambient root and the current proxy CA into `LocalMachine\\Root`;
3. re-read the store and verify every required DER SHA-256 fingerprint;
4. atomically replace the manifest and combined Node bundle;
5. set and verify machine-scoped `NODE_EXTRA_CA_CERTS`, including the bundle's expected fingerprints; and
6. remove a superseded, provably managed proxy CA and verify the final store.

A root import is idempotent. Stop at the first failed operation and do not roll back successful imports: certificates, valid managed PEMs, and the previously published Node bundle remain safe residual state. A failure before atomic publication leaves the previous complete bundle active. A failure after publication may temporarily leave both old and new proxy certificates in the Windows store; the command still fails, and full replay retries the removal. Replay re-enumerates and fingerprints everything, skips verified work, repairs files and the bundle, and converges without phase resume.

If the managed directory or manifest is missing, reconstruct what can be proven from valid fingerprint-named PEMs and a valid proxy PEM. Restore a missing store entry from a valid managed PEM and atomically rewrite derived state. Do not silently discard malformed PEMs, broaden trust from unvalidated data, or delete a certificate when the proxy file and manifest disagree about ownership; fail before provisioning instead.

### Failures and diagnostics

Expose a Windows-specific typed reconciliation failure that identifies the operation (`host enumeration`, `guest fingerprint`, `ambient import`, `proxy import`, `bundle publication`, `environment update`, `proxy cleanup`, or `verification`), trust category, abbreviated SHA-256 where applicable, and the executor's bounded stdout/stderr. Progress reports counts and abbreviated fingerprints only. Never include PEM/base64 content, certificate subjects, credentials, request scripts, or secret-bearing executor state in console errors or durable diagnostics.

Every failure prevents the first provisioning step from running. Retain no ad hoc temporary file after normal completion; best-effort cleanup removes staged files after failure, while the stable managed state remains for diagnosis and replay.

### `configure-network` interaction

Adapt the shipped Windows `configure-network` step in [Define shipped Windows step compatibility changes](09-define-shipped-windows-step-compatibility.md). It should verify that the proxy fingerprint and Node bundle were reconciled, configure Git's global `http.sslBackend=schannel` idempotently, clear the DNS cache, and report readiness. Missing or mismatched trust is a provisioning failure, not a reason for the step to repair certificates through a second ownership path.
