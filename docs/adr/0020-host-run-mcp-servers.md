# Host-run MCP servers are reached through the proxy stack

susentorno launches declared Model Context Protocol servers on host loopback and exposes each to an isolated guest as HTTPS on a dedicated hostname. Envoy terminates guest TLS and forwards cleartext through `host.docker.internal` to the server's assigned `127.0.0.1` port. This gives guest tools access to host-credentialed capabilities without placing the host credentials in the guest or opening another firewall port ([[egress-through-host-envoy-proxy]], [[host-side-dns-and-dhcp]]).

Host-run MCP servers have no application-layer authentication or credential injection. The Internal switch and its isolation name are the trust boundary: every process in every guest attached to that switch can use every declared server. Guests that must not share that authority require distinct isolation names and host networks.

An MCP declaration is a local route outside the external-destination network policy. It wins a hostname collision with the allow, auth, or block list, including a wildcard block-list match, and the displaced entry is reported as a warning. This ensures that an explicitly declared local service remains reachable rather than accidentally resolving to an external route.

## Considered Options

- **Bind MCP ports directly on the guest-facing adapter.** Rejected because it creates a side channel and firewall rule per server instead of reusing the existing TLS and `:443` boundary.
- **Scrape a server-selected port from stdout.** Rejected in favor of assigning a free loopback port and substituting `{ip}` and `{port}` into the command, which establishes the Envoy upstream before launch without coupling to server log formats.
- **Add a shared bearer token.** Rejected because the chosen authorization boundary is the isolated host network itself; a guest-held token would not distinguish the coding agent from other processes in that guest.

## Consequences

- MCP routes have their own `ALLOW MCP` access-log classification and their hostnames are included in the derived TLS leaf ([[envoy-access-log-contract]], [[root-ca-plus-derived-leaf]]).
- `run-hosting` reads `mcp-servers.yaml` once at startup, assigns ports, launches all declared servers, and supervises them for its entire lifetime. Envoy may become reachable while a server is still starting, but a readiness timeout or later process exit is fatal to the whole owned hosting lifecycle ([[run-hosting-owns-hosting-lifecycle]], [[run-hosting-speaks-on-abnormal-exit]]).
- `update-shares` generates idempotent post-isolation registration scripts for the Claude and Codex CLIs from the same declarations.
