# Proxy logging design

Date: 2026-07-06

## Problem

The Envoy proxy is the VM's only network path, but it emits no access logs today — only Envoy's own operational messages at `info` level. There is no way to see which domains the VM reached or, more importantly, which were blocked. Blocked `:443` connections are the worst case: when an SNI matches no allow-listed filter chain, Envoy silently resets the TCP connection with no log line at all.

## Goal

Give the operator visibility into how the proxy handled each host, distinguishing:

- **blocked** vs **allowed** (the primary ask)
- **SSL** (`:443`) vs **non-SSL** (`:80`)
- **credential-injected** (`:443` TLS-terminated) vs **passthrough** (`:443` SNI forward proxy)

Delivered through a dedicated `configamatron proxy-logs` CLI command with live-follow and dedup/debounce modes.

## Tag taxonomy

One friendly tag per distinct traffic path. The tag encodes the decision, the protocol, and whether credentials were injected:

| Tag          | Path                        | SSL | Credentials         |
| ------------ | --------------------------- | --- | ------------------- |
| `ALLOW CRED` | `:443` TLS-terminated       | yes | real token injected |
| `ALLOW PASS` | `:443` SNI passthrough      | yes | none (VM's own TLS) |
| `ALLOW HTTP` | `:80` allowed               | no  | none                |
| `BLOCK TLS`  | `:443` no SNI match         | yes | —                   |
| `BLOCK HTTP` | `:80` default-deny          | no  | —                   |

Every emitted line also carries a timestamp and the domain.

## Section 1 — Envoy-side: emitting the access logs

Two changes to `src/envoyConfig.ts` (the `envoy.yaml` generator).

### 1a. Catch-all `:443` filter chain

Add a final filter chain on `listener_443` with no `server_names` match (Envoy's default filter chain). Its only job is to log the rejected SNI and close the connection. This is the one **structural** change to the config — it is what makes `BLOCK TLS` exist at all. Without it, blocked `:443` connections remain invisible.

### 1b. Access log on every path

Attach an `access_log` to every path — the terminate HCM(s), the passthrough TCP proxy, the `:80` HCM, and the new catch-all chain — all writing to `/dev/stdout`. Envoy's operational chatter stays on stderr; `docker compose logs` captures both, and the CLI separates them by prefix.

Rather than bake the final human tag into Envoy's format string, each path emits a **stable, machine-parseable prefix** that the CLI maps to the friendly tag:

```
CFGM|<path-id>|%START_TIME%|%REQUESTED_SERVER_NAME%|%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%
```

- `path-id` is a literal per location: `term` (`:443` terminate), `pass` (`:443` passthrough), `http` (`:80` HCM), `deny443` (catch-all).
- The `CFGM|` prefix is how the CLI distinguishes access lines from Envoy noise.
- `%RESPONSE_CODE_DETAILS%` resolves the one ambiguous case: `:80` allow-vs-block share a single HCM, but blocked hits are a `direct_response` (details = `direct_response`) while allowed hits are `via_upstream`. The CLI uses this to pick `ALLOW HTTP` vs `BLOCK HTTP`. All other paths are unambiguous from `path-id` alone.

**Why structured-prefix + CLI classification** (rather than friendly tags in Envoy): the tag mapping and the port-80 discrimination become pure functions in the CLI, where this repo already concentrates its unit tests. The Envoy config stays declarative.

**Credential safety:** the format logs only server name, authority/Host, timestamp, and response-code details — never the `Authorization` header. No injected token can leak into logs.

## Section 2 — The `configamatron proxy-logs` command

New command in `src/commands/proxyLogs.ts`, registered in `src/cli.ts`, operating on the current environment via `requireEnvPathsOrExit` (same convention as the other commands).

### Data source

Spawn `docker compose logs --follow --no-log-prefix envoy` via `execa`, run in `paths.proxy` (the folder holding `docker-compose.yml`), inheriting `process.env` so `ENVOY_*` port overrides flow through — the same pattern as `recreateContainer`. Read the child's stdout line-by-line. `--no-follow` drops `--follow` from this invocation for a one-shot dump.

### Pipeline

Each stage is a pure, unit-testable function over lines:

1. **Parse** — keep only `CFGM|…` lines; split into `{ pathId, time, serverName, authority, codeDetails }`. Non-matching lines (Envoy operational noise, malformed lines) are dropped.
2. **Classify** — map `pathId` (+ `codeDetails` for `http`) to a friendly tag. Domain comes from `serverName` (`:443`) or `authority` (`:80`).
3. **Filter** — apply `--blocked` narrowing.
4. **Reduce** — apply the dedup mode.
5. **Format** — print `HH:MM:SS  TAG  domain` (+ count suffix in debounce mode).

### Flags

| Flag                   | Behavior                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| _(none)_               | Follow everything — all tagged lines, live.                                                                                           |
| `--blocked`            | Only `BLOCK *` lines.                                                                                                                 |
| `--unique`             | First occurrence of each `(domain, TAG)` for the session; suppress all repeats. No count.                                            |
| `--debounce <seconds>` | Per `(domain, TAG)`: print, then suppress identical lines until `<seconds>` elapse; the reprint carries `(xN since HH:MM:SS)`.       |
| `--no-follow`          | One-shot dump of recent history, then exit.                                                                                          |

- **Dedup key** is `(domain, TAG)` — "this host, handled this way." The same host seen as `ALLOW CRED` and later `BLOCK TLS` is two distinct keys.
- `--unique` and `--debounce` are mutually exclusive (error if both given).
- **Debounce time source** is the parsed `%START_TIME%` from each line, not wall-clock, so the window reflects when traffic actually happened and replays correctly under `--no-follow`.
- On SIGINT, kill the child process and exit 0 — same lifecycle convention as `run-proxy`.

## Section 3 — Testing

### Unit tests (the bulk)

- `parseLine` — `CFGM|` lines parse correctly; Envoy noise and malformed lines are dropped.
- `classify` — each `pathId` → correct tag; the `http` + `direct_response` vs `via_upstream` split → `BLOCK HTTP` / `ALLOW HTTP`.
- `filter` — `--blocked` keeps only `BLOCK *`.
- `reduce` — `--unique` emits first-only; `--debounce` suppresses within window and reprints with the correct `(xN since …)` count, driven by parsed `START_TIME` (no real clock).
- Flag validation — `--unique` + `--debounce` together errors.

### `envoyConfig.ts` unit tests

Extend the existing suite: every path carries an `access_log` to `/dev/stdout` with the expected `CFGM|<path-id>|…` format, and the catch-all `deny443` filter chain is present and last on `listener_443`.

### Integration test

Extend the existing harness (brings the stack up against a mock upstream on transient ports) to assert Envoy emits `CFGM|` lines: hit an allow-listed host (expect `CFGM|term|…` / `CFGM|pass|…`) and a non-allow-listed SNI (expect `CFGM|deny443|…`).

### e2e test

`proxy-logs` outside an environment prints the standard missing-environment error and exits 1 (wiring / `requireEnvPathsOrExit`, consistent with other commands). Live-stream parsing is covered at the unit level, not e2e.

## Rollout

This changes `envoy.yaml` output (new `access_log` fields and one new filter chain; no allow-list format change). Existing environments pick it up by re-running `configamatron build-envoy-config` and restarting the proxy.

## Docs

- `usage.md` — a "Watching proxy traffic" note covering `proxy-logs` and its modes.
- `technical-notes.md` — the `CFGM|` log-line contract and the catch-all chain.
