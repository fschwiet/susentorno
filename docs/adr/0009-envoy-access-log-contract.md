# Envoy emits a machine-parseable access-log line, classified in `run-proxy`

Every Envoy path writes a stable, pipe-delimited access-log line to stdout — `CFGM|<path-id>|<start-time>|<server-name>|<authority>|<response-code-details>|…` — which `run-proxy` parses and maps to friendly tags (`ALLOW CRED`/`ALLOW PASS`/`ALLOW HTTP`/`BLOCK TLS`/`BLOCK HTTP`) in its inline stream. The friendly-tag mapping lives in the CLI (where the repo concentrates its unit tests), keeping the Envoy config declarative. A catch-all `:443` filter chain routes unmatched SNI to an **endpoint-less `blackhole` cluster** purely so blocked TLS connections are visible (`deny443`) — without it, Envoy silently resets them with no log line at all.

## Consequences

- The `CFGM|` line format is a contract between Envoy and `run-proxy`'s parser; extending it (later adding `response_code`, flags, duration, bytes-sent for real success/failure diagnosis) means bumping the parser's expected field count in step.
- **The access-log format never includes the `Authorization` header.** On terminated paths Envoy's `credential_injector` has already replaced it with the *real* token by log time, so logging it would leak the production credential into docker logs — a hard invariant. (The separate `auth candidate` path is the only one that logs header material, and only a 12-char scheme prefix truncated in the Envoy config — see [[allowlist-format-and-parse-trust-boundary]].)
