# Guest egress is forced through a host Envoy proxy

An isolated guest's only path off-box is the Envoy-based proxy stack on the host. Envoy enforces the environment's network policy ([[split-allow-auth-block-lists-and-skip-allow-list]]) at the TLS/HTTP connection layer rather than at DNS: on `:443` it routes by SNI to credential injection, authentication observation, end-to-end passthrough, or denial; on `:80` it routes by `Host`. A block-list match always denies an external destination, while `run-hosting --skip-allow-list` changes only otherwise-unmatched traffic from denial to open passthrough.

## Considered Options

- **Terminate every TLS connection.** Rejected because destinations that need no credential handling should keep their real upstream certificate. Selective termination limits interception to where it is required.

## Consequences

- Envoy resolves and connects using the SNI- or Host-derived name, so mismatched SNI cannot be used to select an allowed route and then reach a different external destination.
- Credential injection, transparent interception, and the root-plus-leaf certificate design build on this boundary: [[credential-injection-at-proxy]], [[transparent-interception-and-network-isolation-boundary]], and [[root-ca-plus-derived-leaf]].
