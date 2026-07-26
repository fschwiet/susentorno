# Guest egress is forced through a host Envoy proxy

The isolated guest VM's only path off-box is an Envoy proxy running in Docker on the host, which is the single point where the egress allow list is enforced — at the TLS/HTTP connection layer, not at DNS. On `:443` Envoy reads the SNI and either **terminates** TLS (only for the small set of hosts that need credential injection or inspection), **passes through** by SNI without decrypting (every other allow-listed host, so they keep their real upstream certificate), or **drops** the connection when nothing matches. On `:80` it filters by `Host` header and 403s anything not allow-listed.

## Considered Options

- **Terminate everything (mitmproxy-style).** Rejected: needless MITM of hosts that need no injection, and it would force us to serve a cert for every host. Passthrough keeps the real chain and limits termination to where it earns its keep.

## Consequences

- SNI/Host is what Envoy routes on, so a client cannot use a mismatched SNI to reach a non-allow-listed destination — Envoy resolves and connects using the SNI-derived hostname itself.
- This is the architectural spine the rest of the ADRs build on: [[credential-injection-at-proxy]], [[transparent-interception-and-network-isolation-boundary]], [[root-ca-plus-derived-leaf]], [[allowlist-format-and-parse-trust-boundary]].
