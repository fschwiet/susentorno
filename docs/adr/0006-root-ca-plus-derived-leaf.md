# Serve a root CA plus a derived leaf, not a single self-signed certificate

The proxy stack's TLS termination uses a durable root CA as the trust anchor installed in guests and a separate leaf signed by that root as the certificate Envoy presents. The leaf carries the current TLS-terminated auth-list and authentication-candidate hosts, plus declared host-run MCP hostnames, as SANs. A certificate that is simultaneously a self-signed CA and end-entity works in curl and Node but is rejected by Firefox, so the two-certificate design is required for consistent guest trust.

## Considered Options

- **Mint a certificate per connection.** Rejected because the terminated hostname set is known when the proxy configuration is built, so one derived leaf covering the complete set is sufficient.

## Consequences

- The root is long-lived key material and is never silently overwritten. The leaf is reissued when its derived SAN set changes, so policy edits and MCP declarations do not require reinstalling trust in guests.
- Each root's CommonName is `susentorno-proxy-certificate-authority-` plus the start of its key identifier, and each leaf carries an authorityKeyIdentifier naming its root's key. A guest can trust two susentorno roots at once (ambient trust copies an older root from the host, ADR-0028), and with one shared name a verifier could check a leaf against the wrong root and fail with "certificate signature failure". Roots made before this keep their original name, since roots are never overwritten. Their leaves are reissued with an authorityKeyIdentifier on the next `generate-ca`.
- `src/ca.ts` uses `node-forge` directly because the former `selfsigned` abstraction could not sign a leaf with a separate CA key.
