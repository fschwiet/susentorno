# 14: Windows guest trust reconciliation as the single trust owner

**What to build:** Windows guest trust reconciliation as production code, run as phase G5. Windows, Git, and Node in the guest then trust the same set of roots: the host ambient roots it has retained plus the current environment proxy CA. The shipped `configure-network` step stops installing certificates itself and only verifies that trust was reconciled. The Windows guest harness uses the production reconciler, and the test-only Windows ambient-trust helper is deleted. See the spec's "Trust reconciliation" and ticket 05, and the `configure-network` and `verify-config.ps1` items in ticket 09.

- **Snapshot:** one immutable snapshot per run:
  - host roots from the existing production host enumerator, with its Disallowed-store and server-authentication EKU policy unchanged;
  - the environment's validated `cert.pem`;
  - DER SHA-256 fingerprints of the guest's `LocalMachine\Root`.
- **Planner (pure):** from the snapshot and the managed manifest, returns either an ordered list of operations or an ownership-ambiguity failure.
  - Ambient trust is additive.
  - The proxy CA is replaceable: the new CA is installed and verified and the bundle published before the old CA is removed, and the old CA is removed only when the manifest proves ownership.
  - Diffing is by lowercase DER SHA-256.
  - If managed state is missing, the planner rebuilds it from valid PEMs. Malformed PEMs are never silently discarded.
- **Applier (executor-driven):**
  - It writes fingerprint-named ambient PEMs, the proxy PEM, the manifest, and one deduplicated combined Node bundle under the managed trust directory. It imports into `LocalMachine\Root` only.
  - It replaces the manifest and bundle atomically, and sets and verifies machine-scoped `NODE_EXTRA_CA_CERTS` to point at the bundle.
  - It stops at the first failure with no rollback.
  - It raises `WindowsTrustReconciliationError`, naming the operation (host enumeration, guest fingerprint, ambient import, proxy import, bundle publication, environment update, proxy cleanup, or verification), the trust category, and an abbreviated fingerprint. The error never includes PEM content, subjects, or credentials.
- **`configure-network` step:**
  - Remove the certificate path parameter, `certutil`, the proxy-CA copy, trust-directory creation, and all machine environment mutation.
  - Validate `-HostIp` as IPv4 without using it.
  - Verify the reconciled proxy fingerprint, the manifest, `NODE_EXTRA_CA_CERTS`, and the bundle's contents. Missing or mismatched state is a failure; the step never repairs it.
  - Set `http.sslBackend=schannel`, check its exit status, read it back, then clear the DNS cache.
- **`verify-config.ps1`:** check DER SHA-256 against the manifest and bundle instead of looking up the proxy by subject, and capture native status immediately after each call.
- **Harness:** the existing Windows guest role calls the production reconciler instead of the test-only helper, which is deleted. Its trust assertions check the proxy fingerprint in the root store, the manifest, and `NODE_EXTRA_CA_CERTS` pointing at the combined bundle.

**Blocked by:** 12

**Status:** resolved

- [x] Planner unit tests cover:
  - a first run;
  - a replay with no change;
  - a new ambient root;
  - an ambient root the host no longer selects, which is retained;
  - proxy rotation;
  - ambiguous ownership, which fails without deleting anything;
  - a proxy CA that is also an ambient root, which is deduplicated and not removed;
  - missing managed state, which is rebuilt;
  - malformed PEMs, which fail.
- [x] Applier unit tests cover the typed failure for each operation and the redaction rules.
- [x] Unit tests of `runWindowsSetup` show that G5 runs after G4, and that a G5 failure prevents every step.
- [x] The existing Windows guest role passes with the production reconciler and the adapted `configure-network` step, including the network-boundary and schannel assertions.
- [x] The unit, CLI, and guest tiers pass.
