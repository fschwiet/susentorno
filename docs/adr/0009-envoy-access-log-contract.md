# Envoy emits a machine-parseable access-log line, classified in `run-hosting`

Every Envoy route writes a stable, pipe-delimited `CFGM|<path-id>|...` line to stdout. `run-hosting` parses that contract and renders friendly classifications such as credentialed, passthrough, open, MCP, and blocked traffic. Keeping classification in the CLI leaves the Envoy configuration declarative and makes the mapping directly unit-testable. An endpoint-less `blackhole` cluster exists so denied TLS connections produce a log event instead of an unobservable reset.

## Consequences

- The Envoy field order and the parser's expected field count must evolve together.
- The normal access-log format never includes `Authorization`, because credential injection has placed a host credential there by log time. Authentication-candidate routes are the sole exception and emit only a scheme prefix truncated in the Envoy configuration, as defined by [[split-allow-auth-block-lists-and-skip-allow-list]].
