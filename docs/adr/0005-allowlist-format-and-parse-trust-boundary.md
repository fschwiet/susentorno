# Allow-list file format, with `parseAllowlist` as the single trust boundary

The egress allow list is a flat text file of `host:port` lines grouped by `#pragma` section headers: `#pragma passthrough` (SNI passthrough, wildcards allowed), `#pragma claude|github|codex authenticated` (TLS-terminate + inject that provider's credential), and `#pragma auth candidate` (TLS-terminate and log a truncated auth-header prefix, no injection — used to discover a host's auth scheme before building injection for it). Wildcards use a single leading `*.host`. `parseAllowlist` (`src/allowlist.ts`) is the **single point** that normalizes, validates, dedupes, prunes redundant entries, and resolves cross-section collisions; every consumer (`generateEnvoyConfig`, leaf SAN derivation, `run-hosting`) trusts its output and does no re-validation.

## Consequences

- **Two error tiers.** A bad single entry (illegal wildcard, a wildcard in a terminate section) is collected as a *warning* and dropped, and the proxy builds the best valid config it can from the survivors — allow-list *content* never kills a running proxy; only a genuinely unreadable file is fatal. A *structural* mistake (an unrecognized `#pragma`, or a legacy bare `# terminate`/`# passthrough` header whose silent-drop would catastrophically un-terminate `api.anthropic.com`) fails loudly instead.
- Cross-section collisions on the same `host:port` resolve by fixed priority (`auth candidate` > provider-authenticated > `passthrough`) with a warning, so Envoy never sees two filter chains matching one SNI.
- `import-sbx-network-policy` is the one boundary that ingests upstream policy files (which use `**.`) and normalizes them to the single `*.` form; it warns and skips wildcard shapes it cannot support.
- `#pragma auth candidate` truncates logged header values to a 12-char scheme prefix *in the Envoy config itself*, so a raw secret never leaves the container.

> The single-file layout described above was later split into `allow-list.txt`, `auth-list.txt`, and `block-list.txt` — see [[split-allow-auth-block-lists-and-skip-allow-list]]. The per-file trust-boundary and two-error-tier principles here still apply to each file individually.
