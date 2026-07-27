# Serve a root CA + a derived leaf, not a single self-signed cert

The proxy's TLS termination uses **two** certificates: a durable **root CA** (the trust anchor installed in the guest's trust store and Firefox, no server SANs) and a **leaf** signed by that root, carrying the terminated hosts as SANs, which is what Envoy actually presents. A single self-signed cert that is simultaneously CA and leaf is accepted by curl and Node but **rejected by Firefox** (mozilla::pkix refuses a self-signed end-entity cert even when trusted), so terminated hosts showed a security warning in the browser.

## Considered Options

- **Dynamic per-connection cert minting (mitmproxy-style).** Unnecessary: the terminated host set is a known, finite list, so one leaf covering all of them suffices.

## Consequences

- The leaf's SANs are derived from the allow list's terminate/authenticated/auth-candidate sections, so adding a terminated host and reissuing keeps them in sync automatically ([[allowlist-format-and-parse-trust-boundary]]).
- The root is long-lived key material (reused, never silently overwritten); the leaf is *derived* and reissued from the current root whenever the SAN set changes, so trust already installed in guests stays valid across allow-list edits.
- `src/ca.ts` uses `node-forge` directly rather than `selfsigned`, which cannot sign a leaf with a separate CA key.
