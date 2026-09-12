# Serve a root CA plus a derived leaf, not a single self-signed certificate

The proxy stack's TLS termination uses a durable root CA as the trust anchor installed in guests and a separate leaf signed by that root as the certificate Envoy presents. The leaf carries the current TLS-terminated auth-list and authentication-candidate hosts, plus declared host-run MCP hostnames, as SANs. A certificate that is simultaneously a self-signed CA and end-entity works in curl and Node but is rejected by Firefox, so the two-certificate design is required for consistent guest trust.

## Considered Options

- **Mint a certificate per connection.** Rejected because the terminated hostname set is known when the proxy configuration is built, so one derived leaf covering the complete set is sufficient.

## Consequences

- The root is long-lived key material and is never silently overwritten. The leaf is reissued when its derived SAN set changes, so policy edits and MCP declarations do not require reinstalling trust in guests.
- `src/ca.ts` uses `node-forge` directly because the former `selfsigned` abstraction could not sign a leaf with a separate CA key.
