# `run-hosting` owns the whole hosting lifecycle as one long-running command

`run-hosting` is the single foreground command that owns the proxy stack and its supporting host services. It reads the allow, auth, and block lists; writes current Claude and Codex secrets; assembles upstream trust; derives the TLS leaf; starts and supervises Envoy colors and declared host-run MCP servers; streams classified access logs; and serves the gateway forwarder, DNS, and DHCP. It watches all three policy files and the Claude and Codex credential sources, applying changes without a separate build or log-viewer command; `mcp-servers.yaml` is deliberately read only at startup.

## Considered Options

- **Separate configuration generation and log-following commands.** Rejected because policy and credential changes need to take effect automatically, and an independent Docker log follower would lose the container across a swap.

## Consequences

- `run-hosting` must remain running for an isolated guest to obtain an address, resolve names, and reach permitted destinations.
- Credential and policy changes use [[blue-green-container-swap-for-restarts]] through the stable gateway described by [[loopback-publish-with-node-forwarder]].
- A fatal MCP-server or proxy-stack failure tears down the owned services together rather than leaving a silently degraded subset.
